//! Resource fetching: Blitz asks, the host fetches.
//!
//! Blitz drives resource loading itself. When an `<img src>` enters the document — from
//! `setAttribute`, from parsed HTML, from anywhere — it resolves the URL against the
//! document's base URL and asks its [`NetProvider`] for the bytes. Same for `<link
//! rel=stylesheet>`, `@font-face` fonts and CSS `background-image`s.
//!
//! WebAssembly has no network of its own, so quox's provider doesn't fetch: it records the
//! request and lets the TypeScript side pull it out ([`QuoxRenderer::take_resource_requests`]),
//! fetch it with Deno's `fetch` — inside Deno's permission sandbox — and pass the bytes back
//! ([`QuoxRenderer::resolve_resource_request`]). The bytes are exactly the same encoded-image
//! byte buffer `set_image_data` takes; only the source differs.
//!
//! Routing through Blitz's own pipeline rather than decoding in TypeScript is what makes
//! `img.src = url` behave like the DOM: Blitz owns URL resolution, per-URL deduplication and
//! caching, applies a decoded image to every node waiting on that URL, and reuses the same
//! path for every other resource kind.

use super::QuoxRenderer;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use wasm_bindgen::prelude::*;

#[derive(Default)]
struct PendingResources {
    /// URLs Blitz has requested that the host hasn't picked up yet.
    queued: Vec<String>,
    /// Handlers waiting for bytes, keyed by the URL Blitz resolved for them.
    handlers: HashMap<String, Vec<Box<dyn NetHandler>>>,
}

/// A [`NetProvider`] that queues requests for the host runtime instead of performing them.
#[derive(Default)]
pub(super) struct QuoxNetProvider {
    pending: Mutex<PendingResources>,
}

impl QuoxNetProvider {
    /// Blitz requires a `Sync` provider, so the queue lives behind a `Mutex` even though wasm
    /// is single-threaded. A poisoned lock means a panic unwound while the queue was held; the
    /// queue is a plain list with no invariant left half-broken, so recovering the data beats
    /// turning every later resource request into a second panic.
    fn pending(&self) -> MutexGuard<'_, PendingResources> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Take the URLs requested since the last call.
    fn take_requests(&self) -> Vec<String> {
        std::mem::take(&mut self.pending().queued)
    }

    /// Hand `bytes` to every handler waiting on `url`, returning whether any was waiting.
    fn deliver(&self, url: &str, bytes: &[u8]) -> bool {
        // Release the lock before running handlers: parsing happens inside `bytes()` (image
        // decoding, CSS parsing), and a stylesheet handler can start nested requests for
        // `@import`ed sheets or `@font-face` fonts, re-entering `fetch` on this provider.
        let waiting = self.pending().handlers.remove(url);

        let Some(handlers) = waiting else {
            return false;
        };

        let bytes = Bytes::from(bytes.to_vec());
        for handler in handlers {
            handler.bytes(url.to_string(), bytes.clone());
        }

        true
    }
}

impl NetProvider for QuoxNetProvider {
    /// Record a request rather than performing it.
    ///
    /// The request's method, headers and body are ignored: everything reaching a document's
    /// `NetProvider` is a resource load, and quox installs no navigation provider, so form
    /// submissions never get here. `request.signal` is ignored too — the host owns the fetch
    /// and aborts it on its own terms (closing the window).
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let mut pending = self.pending();
        let PendingResources { queued, handlers } = &mut *pending;

        match handlers.entry(request.url.to_string()) {
            // A URL the host is already fetching: two `<img>` sharing a `src`, an image also
            // used as a CSS background, a font requested by two stylesheets. One fetch serves
            // them all — queue the handler and let `deliver` fan the bytes out.
            Entry::Occupied(mut entry) => entry.get_mut().push(handler),
            Entry::Vacant(entry) => {
                queued.push(entry.key().clone());
                entry.insert(vec![handler]);
            }
        }
    }
}

#[wasm_bindgen]
impl QuoxRenderer {
    /// Drain the URLs of resources the document is waiting on, in request order.
    ///
    /// Each URL is reported once: while a request is outstanding, further references to the
    /// same URL attach to it instead of queueing again. The host is expected to fetch every
    /// returned URL and answer it with `resolve_resource_request` or `fail_resource_request`;
    /// a URL that is never answered leaves the nodes referencing it unpainted, and blocks a
    /// later retry of that same URL.
    pub fn take_resource_requests(&self) -> Vec<String> {
        self.state.borrow().net_provider.take_requests()
    }

    /// Hand a fetched resource's bytes to the document, returning whether a redraw is needed.
    ///
    /// `bytes` is the resource's raw encoded content — for an image, the same byte buffer
    /// `set_image_data` takes. Blitz decodes/parses it here and applies the result to every
    /// node that referenced `url`; unknown URLs are ignored (`false`).
    pub fn resolve_resource_request(&self, url: &str, bytes: &[u8]) -> bool {
        // Take what's needed and drop the borrow: delivery runs Blitz's own handlers, which
        // may call back into this renderer's net provider for nested resources.
        let (net_provider, redraw_requested) = {
            let state = self.state.borrow();
            (
                Arc::clone(&state.net_provider),
                Arc::clone(&state.redraw_requested),
            )
        };

        if !net_provider.deliver(url, bytes) {
            return false;
        }

        // Delivery only decodes and queues the result as a document event. Apply it before
        // returning, so the document has stopped waiting on `url` by the time the caller sees
        // the outcome — otherwise a reference to the same URL set right after a failure would
        // attach to the request that just ended and never be fetched again.
        self.state.borrow_mut().document.handle_messages();

        redraw_requested.swap(false, Ordering::Relaxed)
    }

    /// Report that a resource could not be fetched, returning whether a redraw is needed.
    ///
    /// Blitz's `NetHandler` has no failure channel — the only way to tell it a request is over
    /// is to hand it bytes. An empty buffer fails every parser it has, so the request resolves
    /// as a load error and Blitz stops waiting on the URL: nodes referencing it keep whatever
    /// they had, and a later retry of the same URL is issued afresh rather than attaching to a
    /// request that will never complete. (A failed stylesheet resolves as an empty stylesheet,
    /// which has the same effect on rendering as none at all.)
    pub fn fail_resource_request(&self, url: &str) -> bool {
        self.resolve_resource_request(url, &[])
    }
}
