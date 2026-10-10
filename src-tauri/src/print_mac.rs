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
//!
//! A print goes on after `print` returns (the panel is a sheet on the window; the pages are laid
//! out on a thread of its own), and the web view must stand until it is over. So `print` hands the
//! web view to the operation's delegate, and it is let go, and taken out of the window, only when
//! AppKit says the operation ran (`didRunSelector`) — not when the caller drops its handle.

use std::cell::RefCell;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSPrintInfo, NSPrintJobDisposition, NSPrintJobSavingURL, NSPrintSaveJob, NSView, NSWindow};
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize, NSString, NSURL};
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

/// A web view with the sheet loaded, standing outside the window's visible area. Dropped before
/// it is printed, it takes its web view out of the window; `print` passes the web view on.
pub struct Sheet {
    view: Option<Retained<WKWebView>>,
}

impl Sheet {
    /// Puts the sheet into a web view inside `host`'s content view, left of its edge: a web view
    /// that is in no window prints blank. It starts loading at once. The web view runs no
    /// JavaScript: the sheet is a page to lay out, whatever the letter holds.
    pub fn load(mtm: MainThreadMarker, host: &NSWindow, html: &str) -> Option<Sheet> {
        let content: Retained<NSView> = host.contentView()?;
        // SAFETY: plain construction on the main thread with a fresh configuration.
        let view = unsafe {
            let frame = NSRect::new(NSPoint::new(-(SHEET.width + 100.0), 0.0), SHEET);
            let config = WKWebViewConfiguration::new(mtm);
            config.defaultWebpagePreferences().setAllowsContentJavaScript(false);
            let view = WKWebView::initWithFrame_configuration(mtm.alloc(), frame, &config);
            content.addSubview(&view);
            view.loadHTMLString_baseURL(&NSString::from_str(html), None);
            view
        };
        Some(Sheet { view: Some(view) })
    }

    /// The page and what it holds (pictures) are still coming.
    pub fn loading(&self) -> bool {
        // SAFETY: a read on the main thread.
        self.view.as_ref().is_some_and(|v| unsafe { v.isLoading() })
    }

    /// Starts printing the sheet and returns at once: a web view paginates on a thread of its own,
    /// and an operation run on the main thread (`runOperation`) waits for it there for good. With
    /// `Output::Panel` the panel is a sheet on `host`, and the print goes on once it is answered;
    /// with `Output::Pdf` the file appears when the pages are written. `done(success)` is called
    /// when AppKit reports the operation over; the web view is let go just before.
    pub fn print(mut self, mtm: MainThreadMarker, host: &NSWindow, output: &Output, done: impl FnOnce(bool) + 'static) {
        let Some(view) = self.view.take() else {
            return done(false);
        };
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
            let operation = view.printOperationWithPrintInfo(&info);
            operation.setCanSpawnSeparateThread(true);
            if matches!(output, Output::Pdf(_)) {
                operation.setShowsPrintPanel(false);
                operation.setShowsProgressPanel(false);
            }
            // The delegate holds the web view and one reference to itself, given back in `did_run`.
            let delegate = PrintDone::new(mtm, view, Box::new(done));
            let delegate = Retained::into_raw(delegate);
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                host,
                Some(&*(delegate as *const AnyObject)),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
    }
}

impl Drop for Sheet {
    fn drop(&mut self) {
        // Not printed: the web view goes out of the window with the sheet.
        if let Some(view) = self.view.take() {
            view.removeFromSuperview();
        }
    }
}

/// What to tell the caller when the operation is over: whether it went through.
type Done = Box<dyn FnOnce(bool)>;

struct DoneIvars {
    /// How the operation ended, written by `did_run` (which may run on the printing thread).
    success: AtomicBool,
    view: RefCell<Option<Retained<WKWebView>>>,
    done: RefCell<Option<Done>>,
}

define_class!(
    /// The delegate of one print operation: keeps its web view until AppKit says it ran.
    // SAFETY: NSObject has no requirements for a subclass, which has no `Drop` of its own.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DepeshaPrintDone"]
    #[ivars = DoneIvars]
    struct PrintDone;

    impl PrintDone {
        // `didRunSelector` of NSPrintOperation: (operation, success, contextInfo). With the pages laid
        // out on a thread of its own, AppKit may call it there, and a web view must not be touched off
        // the main thread (WebKit stops the process): the end is passed on to the main thread.
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _operation: &AnyObject, success: bool, _info: *mut c_void) {
            self.ivars().success.store(success, Ordering::SeqCst);
            // SAFETY: `finish` is below; the selector keeps `self` alive until it has run.
            unsafe {
                let _: () = msg_send![self, performSelectorOnMainThread: sel!(finish), withObject: None::<&AnyObject>, waitUntilDone: false];
            }
        }

        #[unsafe(method(finish))]
        fn finish(&self) {
            if let Some(view) = self.ivars().view.borrow_mut().take() {
                view.removeFromSuperview();
            }
            if let Some(done) = self.ivars().done.borrow_mut().take() {
                done(self.ivars().success.load(Ordering::SeqCst));
            }
            // SAFETY: gives back the reference `print` kept for the operation; nothing here touches `self` after.
            unsafe { drop(Retained::from_raw(self as *const Self as *mut Self)) };
        }
    }
);

impl PrintDone {
    fn new(mtm: MainThreadMarker, view: Retained<WKWebView>, done: Done) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(DoneIvars {
            success: AtomicBool::new(false),
            view: RefCell::new(Some(view)),
            done: RefCell::new(Some(done)),
        });
        // SAFETY: `init` of the superclass, as `define_class!` expects.
        unsafe { msg_send![super(this), init] }
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
