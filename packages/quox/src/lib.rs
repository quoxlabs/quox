use anyrender_vello::VelloScenePainter;
use blitz_dom::{
    BaseDocument, DEFAULT_CSS, DocumentConfig, DocumentMutator, FontContext, LocalName, NodeData,
    Point, QualName, ns,
};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_paint::paint_scene;
use blitz_traits::net::DummyNetProvider;
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use linebender_resource_handle::Blob;
use std::cell::RefCell;
use std::sync::Arc;
use vello::wgpu::{CompositeAlphaMode, PresentMode, SurfaceTarget, TextureFormat, TextureUsages};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::{JsCast, prelude::*};
use wgpu_context::{
    SurfaceRenderer, SurfaceRendererConfiguration, TextureConfiguration, WGPUContext,
};

const LIBERATION_SANS: &[u8] = include_bytes!("../assets/LiberationSans-Regular.ttf");
const FONT_CSS: &str = "html,body,*{font-family:'Liberation Sans',sans-serif;}";

fn initial_html(head: &str, body: &str) -> String {
    format!("<!DOCTYPE html><html><head>{head}</head><body>{body}</body></html>")
}

fn html_name(local_name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(html),
        local: LocalName::from(local_name),
    }
}

fn attr_name(local_name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(),
        local: LocalName::from(local_name),
    }
}

fn invalid_node(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("Invalid DOM node id: {node_id}"))
}

fn invalid_element(node_id: usize) -> JsValue {
    JsValue::from_str(&format!("DOM node id is not an element: {node_id}"))
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Renders HTML documents to native WebGPU surfaces using Blitz + Vello.
#[wasm_bindgen]
pub struct QuoxRenderer {
    state: RefCell<QuoxRendererState>,
}

struct QuoxRendererState {
    document: BaseDocument,
    width: u32,
    height: u32,
    scroll_x: u32,
    scroll_y: u32,
    context: WGPUContext,
    dev_id: usize,
    renderer: Renderer,
    canvas_surface: Option<SurfaceRenderer<'static>>,
}

impl QuoxRendererState {
    fn create_renderer_for_device(&self, dev_id: usize) -> Result<Renderer, JsValue> {
        Renderer::new(
            &self.context.device_pool[dev_id].device,
            RendererOptions {
                use_cpu: false,
                num_init_threads: None,
                antialiasing_support: AaSupport::area_only(),
                pipeline_cache: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Vello renderer: {e:?}")))
    }

    fn use_device(&mut self, dev_id: usize) -> Result<(), JsValue> {
        if self.dev_id == dev_id {
            return Ok(());
        }

        self.renderer = self.create_renderer_for_device(dev_id)?;
        self.dev_id = dev_id;
        Ok(())
    }

    fn build_scene(&mut self) -> (Scene, u32, u32) {
        let w = self.width;
        let h = self.height;

        self.document
            .set_viewport(Viewport::new(w, h, 1.0, ColorScheme::Light));
        self.document.resolve(0.0);

        // Clamp scroll offsets to the laid-out content size so the viewport
        // can never scroll past the end of the document.
        let content = self.document.root_element().final_layout.size;
        self.scroll_x = self.scroll_x.min((content.width as u32).saturating_sub(w));
        self.scroll_y = self.scroll_y.min((content.height as u32).saturating_sub(h));
        self.document.set_viewport_scroll(Point {
            x: self.scroll_x as f64,
            y: self.scroll_y as f64,
        });

        let mut scene = Scene::new();
        let mut painter = VelloScenePainter::new(&mut scene);
        paint_scene(&mut painter, &self.document, 1.0, w, h, 0, 0);

        (scene, w, h)
    }

    fn mutate_document<T>(
        &mut self,
        op: impl FnOnce(&mut DocumentMutator<'_>) -> Result<T, JsValue>,
    ) -> Result<T, JsValue> {
        let mut mutator = self.document.mutate();
        let result = op(&mut mutator);
        drop(mutator);

        result
    }

    fn ensure_node(&self, node_id: usize) -> Result<(), JsValue> {
        self.document
            .get_node(node_id)
            .map(|_| ())
            .ok_or_else(|| invalid_node(node_id))
    }

    fn ensure_element(&self, node_id: usize) -> Result<(), JsValue> {
        self.document
            .get_node(node_id)
            .ok_or_else(|| invalid_node(node_id))?
            .element_data()
            .map(|_| ())
            .ok_or_else(|| invalid_element(node_id))
    }

    fn child_element_by_tag(&self, parent_id: usize, tag_name: &str) -> Result<usize, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_node(parent_id))?;

        parent
            .children
            .iter()
            .find_map(|child_id| {
                let child = self.document.get_node(*child_id)?;
                let element = child.element_data()?;
                (element.name.local.as_ref() == tag_name).then_some(*child_id)
            })
            .ok_or_else(|| JsValue::from_str(&format!("Missing <{tag_name}> element")))
    }

    fn optional_child_element_by_tag(
        &self,
        parent_id: usize,
        tag_name: &str,
    ) -> Result<Option<usize>, JsValue> {
        let parent = self
            .document
            .get_node(parent_id)
            .ok_or_else(|| invalid_node(parent_id))?;

        Ok(parent.children.iter().find_map(|child_id| {
            let child = self.document.get_node(*child_id)?;
            let element = child.element_data()?;
            (element.name.local.as_ref() == tag_name).then_some(*child_id)
        }))
    }

    /// Find the document's `<title>` element, if any. Mirrors the HTML spec's tolerance for a
    /// missing `<head>` (e.g. after `document.head.remove()`) by returning `None` rather than
    /// failing, so title lookups never break unrelated DOM operations.
    fn title_element(&self) -> Result<Option<usize>, JsValue> {
        let Some(head_id) =
            self.optional_child_element_by_tag(self.document.root_element().id, "head")?
        else {
            return Ok(None);
        };
        self.optional_child_element_by_tag(head_id, "title")
    }
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Initialise a renderer with a live document and viewport dimensions.
    ///
    /// Acquires a WebGPU device; must be `await`ed.
    pub async fn create(
        width: u32,
        height: u32,
        head: &str,
        body: &str,
    ) -> Result<QuoxRenderer, JsValue> {
        let mut context = WGPUContext::new();
        let dev_id = context
            .find_or_create_device(None)
            .await
            .map_err(|e| JsValue::from_str(&format!("WebGPU device: {e:?}")))?;

        let renderer = Renderer::new(
            &context.device_pool[dev_id].device,
            RendererOptions {
                use_cpu: false,
                num_init_threads: None,
                antialiasing_support: AaSupport::area_only(),
                pipeline_cache: None,
            },
        )
        .map_err(|e| JsValue::from_str(&format!("Vello renderer: {e:?}")))?;

        let mut font_ctx = FontContext::default();
        font_ctx
            .collection
            .register_fonts(Blob::new(Arc::new(LIBERATION_SANS) as _), None);

        let document = HtmlDocument::from_html(
            &initial_html(head, body),
            DocumentConfig {
                base_url: Some("https://example.com".to_string()),
                net_provider: Some(Arc::new(DummyNetProvider::default())),
                shell_provider: Some(Arc::new(DummyShellProvider)),
                html_parser_provider: Some(Arc::new(HtmlProvider)),
                ua_stylesheets: Some(vec![DEFAULT_CSS.to_string(), FONT_CSS.to_string()]),
                font_ctx: Some(font_ctx),
                ..Default::default()
            },
        )
        .into_inner();

        Ok(QuoxRenderer {
            state: RefCell::new(QuoxRendererState {
                document,
                width: width.max(1),
                height: height.max(1),
                scroll_x: 0,
                scroll_y: 0,
                context,
                dev_id,
                renderer,
                canvas_surface: None,
            }),
        })
    }

    /// Resize the rendering viewport.
    pub fn resize(&self, width: u32, height: u32) {
        let mut state = self.state.borrow_mut();
        state.width = width.max(1);
        state.height = height.max(1);
    }

    /// Scroll the viewport by the given pixel delta. Negative values scroll
    /// towards the top/left; the position is clamped to 0 at the origin.
    pub fn scroll(&self, delta_x: i32, delta_y: i32) {
        let mut state = self.state.borrow_mut();
        state.scroll_x = state.scroll_x.saturating_add_signed(delta_x);
        state.scroll_y = state.scroll_y.saturating_add_signed(delta_y);
    }

    /// Remove a node from the retained document.
    pub fn remove_node(&self, node_id: usize) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_node(node_id)?;
        state.mutate_document(|mutator| {
            mutator.remove_node(node_id);
            Ok(())
        })
    }

    // Append `child_id` to `parent_id`.
    pub fn append_child(&self, parent_id: usize, child_id: usize) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_node(parent_id)?;
        state.ensure_node(child_id)?;
        state.mutate_document(|mutator| {
            mutator.append_children(parent_id, &[child_id]);
            Ok(())
        })
    }

    /// Return a node's text content.
    pub fn text_content(&self, node_id: usize) -> Result<String, JsValue> {
        let state = self.state.borrow();
        state
            .document
            .get_node(node_id)
            .map(|node| node.text_content())
            .ok_or_else(|| invalid_node(node_id))
    }

    /// Return the document title.
    pub fn title(&self) -> Result<String, JsValue> {
        let state = self.state.borrow();
        match state.title_element()? {
            Some(node_id) => state
                .document
                .get_node(node_id)
                .map(|node| node.text_content())
                .ok_or_else(|| invalid_node(node_id)),
            None => Ok(String::new()),
        }
    }

    /// Set an element attribute.
    pub fn set_attribute(&self, node_id: usize, name: &str, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.set_attribute(node_id, attr_name(name), value);
            Ok(())
        })
    }

    /// Create an element node in the retained document.
    pub fn create_element(&self, tag_name: &str) -> Result<usize, JsValue> {
        let mut state = self.state.borrow_mut();
        state.mutate_document(|mutator| {
            Ok(mutator.create_element(html_name(&tag_name.to_ascii_lowercase()), Vec::new()))
        })
    }

    /// Replace an element's children by parsing an HTML fragment through Blitz's mutator.
    pub fn set_inner_html(&self, node_id: usize, html: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.set_inner_html(node_id, html);
            Ok(())
        })
    }

    /// Create a text node in the retained document.
    pub fn create_text_node(&self, text: &str) -> Result<usize, JsValue> {
        let mut state = self.state.borrow_mut();
        state.mutate_document(|mutator| Ok(mutator.create_text_node(text)))
    }

    /// Return the root `<html>` element node id.
    pub fn document_element(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        Ok(state.document.root_element().id)
    }

    /// Remove an element attribute.
    pub fn remove_attribute(&self, node_id: usize, name: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        state.ensure_element(node_id)?;
        state.mutate_document(|mutator| {
            mutator.clear_attribute(node_id, attr_name(name));
            Ok(())
        })
    }

    /// Replace a node's text content.
    pub fn set_text_content(&self, node_id: usize, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let is_text_node = {
            let node = state
                .document
                .get_node(node_id)
                .ok_or_else(|| invalid_node(node_id))?;
            matches!(&node.data, NodeData::Text(_))
        };

        state.mutate_document(|mutator| {
            if is_text_node {
                mutator.set_node_text(node_id, value);
            } else {
                mutator.remove_and_drop_all_children(node_id);
                if !value.is_empty() {
                    let text_id = mutator.create_text_node(value);
                    mutator.append_children(node_id, &[text_id]);
                }
            }

            Ok(())
        })
    }

    /// Replace the first document `<title>` text, creating the element in `<head>` if needed.
    /// Mirrors the HTML spec's `document.title` setter: if there is no `<head>` (e.g. after
    /// `document.head.remove()`), this is a no-op rather than an error.
    pub fn set_title(&self, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let Some(head_id) =
            state.optional_child_element_by_tag(state.document.root_element().id, "head")?
        else {
            return Ok(());
        };
        let existing_title_id = state.optional_child_element_by_tag(head_id, "title")?;

        state.mutate_document(|mutator| {
            let title_id = existing_title_id.unwrap_or_else(|| {
                let title_id = mutator.create_element(html_name("title"), Vec::new());
                mutator.append_children(head_id, &[title_id]);
                title_id
            });

            mutator.remove_and_drop_all_children(title_id);
            if !value.is_empty() {
                let text_id = mutator.create_text_node(value);
                mutator.append_children(title_id, &[text_id]);
            }

            Ok(())
        })
    }

    /// Return the document `<body>` node id.
    pub fn body(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        state.child_element_by_tag(state.document.root_element().id, "body")
    }

    /// Return the document `<head>` node id.
    pub fn head(&self) -> Result<usize, JsValue> {
        let state = self.state.borrow();
        state.child_element_by_tag(state.document.root_element().id, "head")
    }

    /// Drop the cached WebGPU surface so the next render creates a fresh one.
    pub fn reset_surface(&self) {
        self.state.borrow_mut().canvas_surface = None;
    }

    /// Render the current HTML directly into a canvas-like WebGPU surface.
    pub async fn render_to_canvas(&self, surface_target: JsValue) -> Result<(), JsValue> {
        let needs_surface = self.state.borrow().canvas_surface.is_none();
        if needs_surface {
            // Deno.UnsafeWindowSurface is not an actual OffscreenCanvas, but
            // wgpu's web backend only needs the structural `getContext`,
            // `width`, and `height` members that both objects provide.
            let surface_target = surface_target.unchecked_into::<web_sys::OffscreenCanvas>();
            let (width, height, mut context) = {
                let mut state = self.state.borrow_mut();
                (
                    state.width,
                    state.height,
                    std::mem::take(&mut state.context),
                )
            };

            let surface_result = context
                .create_surface(
                    SurfaceTarget::OffscreenCanvas(surface_target),
                    SurfaceRendererConfiguration {
                        usage: TextureUsages::RENDER_ATTACHMENT,
                        formats: vec![TextureFormat::Rgba8Unorm, TextureFormat::Bgra8Unorm],
                        width,
                        height,
                        present_mode: PresentMode::AutoVsync,
                        desired_maximum_frame_latency: 2,
                        alpha_mode: CompositeAlphaMode::Auto,
                        view_formats: vec![],
                    },
                    Some(TextureConfiguration {
                        usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING,
                    }),
                )
                .await;

            let mut state = self.state.borrow_mut();
            state.context = context;
            let surface = surface_result
                .map_err(|e| JsValue::from_str(&format!("WebGPU canvas surface: {e:?}")))?;

            let dev_id = surface.dev_id;
            state.use_device(dev_id)?;
            state.canvas_surface = Some(surface);
        }

        let mut state = self.state.borrow_mut();
        let (scene, w, h) = state.build_scene();
        let QuoxRendererState {
            renderer,
            canvas_surface,
            ..
        } = &mut *state;
        let surface = canvas_surface
            .as_mut()
            .ok_or_else(|| JsValue::from_str("WebGPU canvas surface was not initialized"))?;
        if surface.config.width != w || surface.config.height != h {
            surface.resize(w, h);
        }

        surface
            .ensure_current_surface_texture()
            .map_err(|e| JsValue::from_str(&format!("WebGPU surface texture: {e:?}")))?;
        let texture_view = surface
            .target_texture_view()
            .map_err(|e| JsValue::from_str(&format!("WebGPU surface texture view: {e:?}")))?;

        renderer
            .render_to_texture(
                surface.device(),
                surface.queue(),
                &scene,
                &texture_view,
                &RenderParams {
                    base_color: vello::peniko::Color::WHITE,
                    width: w,
                    height: h,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| JsValue::from_str(&format!("Vello render: {e:?}")))?;

        drop(texture_view);
        surface
            .maybe_blit_and_present()
            .map_err(|e| JsValue::from_str(&format!("WebGPU present: {e:?}")))?;

        Ok(())
    }
}
