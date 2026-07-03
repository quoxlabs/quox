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
use vello::wgpu::{
    self, BufferDescriptor, BufferUsages, Extent3d, TexelCopyBufferInfo, TexelCopyBufferLayout,
    TextureDescriptor, TextureDimension, TextureFormat, TextureUsages, TextureViewDescriptor,
};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use wgpu_context::WGPUContext;

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

/// Renders HTML documents to RGBA pixel buffers using WebGPU (Blitz + Vello).
///
/// Designed to run inside the Deno runtime, which provides native WebGPU
/// support. The caller is responsible for displaying the returned pixel data,
/// e.g. via X11 FFI using `XPutImage`.
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
}

impl QuoxRendererState {
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

    fn title_element(&self) -> Result<Option<usize>, JsValue> {
        let head_id = self.child_element_by_tag(self.document.root_element().id, "head")?;
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
    pub fn set_title(&self, value: &str) -> Result<(), JsValue> {
        let mut state = self.state.borrow_mut();
        let head_id = state.child_element_by_tag(state.document.root_element().id, "head")?;
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

    /// Render the current HTML and return a flat `width × height × 4`
    /// RGBA byte buffer (`TextureFormat::Rgba8Unorm`).
    pub async fn render(&self) -> Result<Vec<u8>, JsValue> {
        let (_texture, gpu_buffer, row_bytes, padded_row_bytes, w, h) = {
            let mut state = self.state.borrow_mut();
            let w = state.width;
            let h = state.height;

            state
                .document
                .set_viewport(Viewport::new(w, h, 1.0, ColorScheme::Light));
            state.document.resolve(0.0);

            // Clamp scroll offsets to the laid-out content size so the viewport
            // can never scroll past the end of the document.
            let content = state.document.root_element().final_layout.size;
            state.scroll_x = state.scroll_x.min((content.width as u32).saturating_sub(w));
            state.scroll_y = state
                .scroll_y
                .min((content.height as u32).saturating_sub(h));
            let scroll_x = state.scroll_x;
            let scroll_y = state.scroll_y;
            state.document.set_viewport_scroll(Point {
                x: scroll_x as f64,
                y: scroll_y as f64,
            });

            let device_handle = state.context.device_pool[state.dev_id].clone();

            let texture = device_handle.device.create_texture(&TextureDescriptor {
                label: Some("quox-target"),
                size: Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::RENDER_ATTACHMENT
                    | TextureUsages::COPY_SRC
                    | TextureUsages::STORAGE_BINDING,
                view_formats: &[],
            });
            let texture_view = texture.create_view(&TextureViewDescriptor::default());

            let mut scene = Scene::new();
            let mut painter = VelloScenePainter::new(&mut scene);
            paint_scene(&mut painter, &state.document, 1.0, w, h, 0, 0);

            state
                .renderer
                .render_to_texture(
                    &device_handle.device,
                    &device_handle.queue,
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

            let row_bytes = w * 4;
            let padded_row_bytes = row_bytes.next_multiple_of(256);
            let out_size = (padded_row_bytes as u64) * (h as u64);
            let gpu_buffer = device_handle.device.create_buffer(&BufferDescriptor {
                label: Some("quox-readback"),
                size: out_size,
                usage: BufferUsages::MAP_READ | BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            let mut encoder =
                device_handle
                    .device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("quox-copy"),
                    });
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                TexelCopyBufferInfo {
                    buffer: &gpu_buffer,
                    layout: TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_row_bytes),
                        rows_per_image: None,
                    },
                },
                texture.size(),
            );
            device_handle.queue.submit([encoder.finish()]);

            (texture, gpu_buffer, row_bytes, padded_row_bytes, w, h)
        };

        let mut rgba = vec![0u8; (w as usize) * (h as usize) * 4];
        let buf_slice = gpu_buffer.slice(..);
        let (tx, rx) = futures_intrusive::channel::shared::oneshot_channel();
        buf_slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let map_res = rx
            .receive()
            .await
            .ok_or_else(|| JsValue::from_str("map_async channel closed"))?;
        map_res.map_err(|e| JsValue::from_str(&format!("map_async: {e:?}")))?;

        {
            let mapped = buf_slice.get_mapped_range();
            let row_bytes_us = row_bytes as usize;
            let padded_us = padded_row_bytes as usize;
            for row in 0..(h as usize) {
                let src = row * padded_us;
                let dst = row * row_bytes_us;
                rgba[dst..dst + row_bytes_us].copy_from_slice(&mapped[src..src + row_bytes_us]);
            }
        }
        gpu_buffer.unmap();

        Ok(rgba)
    }
}
