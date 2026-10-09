//! Printing a letter's sheet on macOS (#70).
//!
//! `window.print()` does nothing in a `WKWebView` that does not answer
//! `_webView:printFrame:`, and wry 0.57's delegate does not (WebKit `UIDelegate.mm`), so the
//! frontend cannot print its sheet from a frame there. The sheet (the page the frontend builds
//! in `printPage.ts`) is loaded here into a web view of its own, which stands behind the
//! window's edge, and that web view is printed: the system's print panel, with its «PDF» menu.
//!
//! Everything here runs on the main thread. `tests/mac_print.rs` prints a sheet into a PDF file
//! through the same code, without the panel.

use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintSaveJob, NSView, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

/// A sheet of A4 in points, the size the page is laid out at.
const SHEET: NSSize = NSSize {
    width: 595.0,
    height: 842.0,
};
/// The margins of the paper, in points (about 14 mm): the sheet's own `@page` rule may not count.
const MARGIN: f64 = 40.0;

/// Where the print goes.
pub enum Output {
    /// The system's print panel, as a sheet on the window.
    Panel,
    /// A PDF file, no panel: for the test.
    Pdf(PathBuf),
}

/// A web view with the sheet loaded, standing outside the window's visible area.
pub struct Sheet {
    view: Retained<WKWebView>,
}

impl Sheet {
    /// Puts the sheet into a web view inside `host`'s content view, left of its edge: a web view
    /// that is in no window prints blank. It starts loading at once.
    pub fn load(mtm: MainThreadMarker, host: &NSWindow, html: &str) -> Option<Sheet> {
        let content: Retained<NSView> = host.contentView()?;
        // SAFETY: plain construction on the main thread with a fresh configuration.
        let view = unsafe {
            let frame = NSRect::new(NSPoint::new(-(SHEET.width + 100.0), 0.0), SHEET);
            let config = WKWebViewConfiguration::new(mtm);
            let view = WKWebView::initWithFrame_configuration(mtm.alloc(), frame, &config);
            content.addSubview(&view);
            view.loadHTMLString_baseURL(&NSString::from_str(html), None);
            view
        };
        Some(Sheet { view })
    }

    /// The page and what it holds (pictures) are still coming.
    pub fn loading(&self) -> bool {
        // SAFETY: a read on the main thread.
        unsafe { self.view.isLoading() }
    }

    /// Starts printing the sheet and returns at once: a web view paginates on a thread of its own,
    /// and an operation run on the main thread (`runOperation`) waits for it there for good. With
    /// `Output::Panel` the panel is a sheet on `host`, and the print goes on once it is answered;
    /// with `Output::Pdf` the file appears when the pages are written. The sheet must stay alive
    /// until then.
    pub fn print(&self, host: &NSWindow, output: &Output) {
        // SAFETY: AppKit calls on the main thread with objects made here.
        unsafe {
            let info = match output {
                Output::Panel => NSPrintInfo::sharedPrintInfo(),
                Output::Pdf(path) => pdf_info(path),
            };
            info.setTopMargin(MARGIN);
            info.setBottomMargin(MARGIN);
            info.setLeftMargin(MARGIN);
            info.setRightMargin(MARGIN);
            let operation = self.view.printOperationWithPrintInfo(&info);
            operation.setCanSpawnSeparateThread(true);
            if matches!(output, Output::Pdf(_)) {
                operation.setShowsPrintPanel(false);
                operation.setShowsProgressPanel(false);
            }
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                host,
                None,
                None,
                std::ptr::null_mut(),
            );
        }
    }
}

impl Drop for Sheet {
    fn drop(&mut self) {
        // The view was added by `load`; removing it twice does nothing.
        self.view.removeFromSuperview();
    }
}

/// A print job that is saved to `path` instead of being spooled.
fn pdf_info(path: &Path) -> Retained<NSPrintInfo> {
    let info = NSPrintInfo::init(NSPrintInfo::alloc());
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let url: &AnyObject = &url;
    // SAFETY: the keys and values are the documented constants and an NSURL; the dictionary is this info's own.
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let dictionary = info.dictionary();
        dictionary.setObject_forKey(url, ProtocolObject::from_ref(NSPrintJobSavingURL));
        // The disposition through the dictionary as well: the setter alone is not always read.
        let saved: &AnyObject = NSPrintSaveJob;
        dictionary.setObject_forKey(saved, ProtocolObject::from_ref(NSPrintJobDisposition));
    }
    info
}
