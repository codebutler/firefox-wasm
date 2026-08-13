// Painting: software RenderDocument blit, GPU/WebRender present, and popup
// compositing/overlay. Split from embed-xul.cpp. See embed-xul.h.
#include "embed-xul.h"
#include <cstring>
#include <cstdlib>
// Paint the current document of the persistent browser to a fresh BGRA buffer
// (width*height*4 bytes). Caller owns/free()s the buffer.
// Composite any open popups (menus, context menus, the app-menu panel, <select>
// dropdowns) onto ctx. Popups live in their own widgets and are separate display
// roots (NS_FRAME_IN_POPUP -> GetDisplayRootFrame stops at the popup), so neither
// the main window's RenderDocument nor its WebRender scene includes them; we paint
// each popup frame at its widget bounds. Our window is at (0,0), so a popup's
// widget bounds are canvas coordinates. Returns the number of popups painted.
static int composite_visible_popups(gfxContext* ctx, mozilla::PresShell* ps,
                                    int width, int height, int32_t appPerCss) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  using mozilla::dom::Document;
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (!pm) return 0;
  nsTArray<nsMenuPopupFrame*> popups;
  pm->GetVisiblePopups(popups);

  // The headless popup widget never sizes the popup frame, so a freshly-shown
  // popup comes up 0-sized; give it the window's inline size, force an intrinsic
  // reflow, then position it. CRITICAL: FlushPendingNotifications can run reflow
  // and script that DESTROYS popup frames, so we must NOT hold the raw
  // nsMenuPopupFrame* (or any entry of `popups`) across a flush -- that was a
  // use-after-free that slowly corrupted memory. Re-query GetVisiblePopups after
  // every flush, and keep the paint pass below flush-free.
  bool sized = false;
  for (auto* pf : popups) {
    if (!pf) continue;
    LayoutDeviceIntRect b = pf->CalcWidgetBounds();
    if (b.width <= 0 || b.height <= 0) {
      pf->SetSize(nsSize(width * appPerCss, height * appPerCss));
      ps->FrameNeedsReflow(pf, mozilla::IntrinsicDirty::FrameAncestorsAndDescendants,
                           NS_FRAME_IS_DIRTY);
      sized = true;
    }
  }
  if (sized) {
    if (Document* d = ps->GetDocument())
      d->FlushPendingNotifications(mozilla::FlushType::Layout);
    popups.Clear();
    pm->GetVisiblePopups(popups);  // the flush may have destroyed frames
    for (auto* pf : popups)
      if (pf) pf->SetPopupPosition(false);
    if (Document* d = ps->GetDocument())
      d->FlushPendingNotifications(mozilla::FlushType::Layout);
    popups.Clear();
    pm->GetVisiblePopups(popups);  // re-query once more before painting
  }

  // Paint pass: no flushes here, so the frame pointers stay valid for its
  // duration. GetVisiblePopups is top-to-bottom; paint back-to-front so the
  // topmost wins.
  int painted = 0;
  for (size_t i = popups.Length(); i-- > 0;) {
    nsMenuPopupFrame* pf = popups[i];
    if (!pf) continue;
    LayoutDeviceIntRect b = pf->CalcWidgetBounds();
    if (b.width <= 0 || b.height <= 0) continue;
    gfxContextMatrixAutoSaveRestore saveMatrix(ctx);
    ctx->SetMatrix(Matrix::Translation((float)b.x, (float)b.y));
    nsRegion dirty(pf->InkOverflowRectRelativeToSelf());
    // value 0 == nsDisplayListBuilderMode::Painting (avoid including the heavy
    // nsDisplayList.h, which drags in IPC/WebRender headers not on our path).
    nsLayoutUtils::PaintFrame(
        ctx, pf, dirty, NS_RGBA(0, 0, 0, 0),
        static_cast<mozilla::nsDisplayListBuilderMode>(0),
        nsLayoutUtils::PaintFrameFlags::SyncDecodeImages);
    painted++;
  }
  return painted;
}

static bool HostWantsPopups() {
  return EM_ASM_INT({
           return (typeof Module !== 'undefined' &&
                   typeof Module['geckoOnPopups'] === 'function')
                      ? 1
                      : 0;
         }) != 0;
}

struct PaintedPopup {
  int32_t id, x, y, w, h;
  uint8_t* pix;
  uint32_t len;
};

// Tight BGRA per visible popup, packed as:
//   u32 count
//   repeat count: i32 id,x,y,w,h; u32 byteLength; u8 pixels[byteLength]; pad to 4
// Caller free()s. Null when nothing is open.
static uint8_t* paint_popup_windows(int width, int height, int32_t* outLen) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  using mozilla::dom::Document;
  if (outLen) *outLen = 0;
  if (!g_docShell) return nullptr;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return nullptr;
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (!pm) return nullptr;
  nsTArray<nsMenuPopupFrame*> popups;
  pm->GetVisiblePopups(popups);
  if (popups.IsEmpty()) return nullptr;

  int32_t appPerCss = AppUnitsPerCSSPixel();
  // Same size/flush dance as composite_visible_popups (do not hold frame
  // pointers across a flush).
  bool sized = false;
  for (auto* pf : popups) {
    if (!pf) continue;
    LayoutDeviceIntRect b = pf->CalcWidgetBounds();
    if (b.width <= 0 || b.height <= 0) {
      pf->SetSize(nsSize(width * appPerCss, height * appPerCss));
      ps->FrameNeedsReflow(pf, mozilla::IntrinsicDirty::FrameAncestorsAndDescendants,
                           NS_FRAME_IS_DIRTY);
      sized = true;
    }
  }
  if (sized) {
    if (Document* d = ps->GetDocument())
      d->FlushPendingNotifications(mozilla::FlushType::Layout);
    popups.Clear();
    pm->GetVisiblePopups(popups);
    for (auto* pf : popups)
      if (pf) pf->SetPopupPosition(false);
    if (Document* d = ps->GetDocument())
      d->FlushPendingNotifications(mozilla::FlushType::Layout);
    popups.Clear();
    pm->GetVisiblePopups(popups);
  }

  nsTArray<PaintedPopup> painted;
  for (size_t i = popups.Length(); i-- > 0;) {
    nsMenuPopupFrame* pf = popups[i];
    if (!pf) continue;
    LayoutDeviceIntRect b = pf->CalcWidgetBounds();
    if (b.width <= 0 || b.height <= 0) continue;
    size_t need = (size_t)b.width * (size_t)b.height * 4;
    uint8_t* pix = (uint8_t*)calloc(need, 1);
    if (!pix) continue;
    RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
        BackendType::SKIA, pix, IntSize(b.width, b.height), b.width * 4,
        SurfaceFormat::B8G8R8A8);
    if (!dt) { free(pix); continue; }
    UniquePtr<gfxContext> ctx = gfxContext::CreateOrNull(dt);
    if (!ctx) { free(pix); continue; }
    nsRegion dirty(pf->InkOverflowRectRelativeToSelf());
    nsLayoutUtils::PaintFrame(
        ctx.get(), pf, dirty, NS_RGBA(0, 0, 0, 0),
        static_cast<mozilla::nsDisplayListBuilderMode>(0),
        nsLayoutUtils::PaintFrameFlags::SyncDecodeImages);
    PaintedPopup rec;
    rec.id = (int32_t)(uintptr_t)pf;
    rec.x = b.x;
    rec.y = b.y;
    rec.w = b.width;
    rec.h = b.height;
    rec.pix = pix;
    rec.len = (uint32_t)need;
    painted.AppendElement(rec);
  }
  if (painted.IsEmpty()) return nullptr;

  size_t total = 4;
  for (auto& rec : painted) {
    uint32_t pad = (4 - (rec.len % 4)) % 4;
    total += 24 + rec.len + pad;
  }
  uint8_t* out = (uint8_t*)malloc(total);
  if (!out) {
    for (auto& rec : painted) free(rec.pix);
    return nullptr;
  }
  uint32_t count = painted.Length();
  memcpy(out, &count, 4);
  size_t off = 4;
  for (auto& rec : painted) {
    memcpy(out + off, &rec.id, 4); off += 4;
    memcpy(out + off, &rec.x, 4); off += 4;
    memcpy(out + off, &rec.y, 4); off += 4;
    memcpy(out + off, &rec.w, 4); off += 4;
    memcpy(out + off, &rec.h, 4); off += 4;
    memcpy(out + off, &rec.len, 4); off += 4;
    memcpy(out + off, rec.pix, rec.len); off += rec.len;
    uint32_t pad = (4 - (rec.len % 4)) % 4;
    if (pad) { memset(out + off, 0, pad); off += pad; }
    free(rec.pix);
  }
  if (outLen) *outLen = (int32_t)total;
  return out;
}

uint8_t* xul_paint(int width, int height) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  using mozilla::dom::Document;
  if (!g_docShell) return nullptr;
  // Track the live window size: the JS side sends the current viewport dimensions
  // on every paint, so the chrome reflows to fill the window (resize support).
  EnsureSize(width, height);
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) {
    printf("xul_paint: no PresShell\n");
    return nullptr;
  }
  ps->UnsuppressPainting();
  if (Document* doc2 = ps->GetDocument()) {
    doc2->FlushPendingNotifications(mozilla::FlushType::Layout);
  }

  int32_t stride = width * 4;
  uint8_t* buf = (uint8_t*)calloc((size_t)height * stride, 1);
  RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
      BackendType::SKIA, buf, IntSize(width, height), stride,
      SurfaceFormat::B8G8R8A8);
  if (!dt) {
    printf("xul_paint: CreateDrawTargetForData failed\n");
    free(buf);
    return nullptr;
  }
  UniquePtr<gfxContext> ctx = gfxContext::CreateOrNull(dt);
  if (!ctx) {
    free(buf);
    return nullptr;
  }
  int32_t appPerCss = AppUnitsPerCSSPixel();  // 60
  nsRect r(0, 0, width * appPerCss, height * appPerCss);
  // DrawCaret: RenderDocument force-hides the text caret by default. We want it
  // visible in focused <input>/<textarea>/contenteditable. (Blinking is disabled
  // via ui.caretBlinkTime=0 in xul_init so a single snapshot never catches the
  // caret in its "off" phase.)
  ps->RenderDocument(r, RenderDocumentFlags::DrawCaret, NS_RGB(255, 255, 255),
                     ctx.get());

  // Composite open popups onto the same buffer (no-op when nothing is open).
  composite_visible_popups(ctx.get(), ps, width, height, appPerCss);
  return buf;  // BGRA8, width*height*4 bytes
}

// GPU mode (GECKO_GPU=1): the in-process WebRender compositor presents directly to
// the page <canvas> via WebGL. We do NOT paint per frame here -- instead we make
// sure the compositor is active + correctly sized and let the refresh driver (driven
// by the command loop's event-loop pump, at the top-level-always-active full frame
// rate) build the WebRender display list and present ON ITS OWN whenever content
// invalidates (loads, hovers, CSS/JS animations). A one-time SchedulePaint (and one
// after each resize) kicks the pipeline; steady-state static frames then cost nothing
// (no forced per-frame PaintSynchronously). Idempotent; cheap to call each tick.
void gpu_ensure_active(int width, int height) {
  using namespace mozilla;
  if (!g_docShell) return;
  EnsureSize(width, height);  // track the live window size (resize support)
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return;
  // Clear the gates that keep a windowless browser from painting (one-time, cheap to
  // re-assert): never-painting, inactive (top-level-always-active forces active),
  // suppressed painting.
  ps->SetNeverPainting(false);
  ps->ActivenessMaybeChanged();
  ps->UnsuppressPainting();
  bool resized = false;
  nsPoint offset;
  nsIWidget* widget = nsContentUtils::GetWidget(ps, &offset);
  if (widget) {
    if (!widget->IsVisible()) widget->Show(true);
    // The windowless widget starts at an empty rect; size it to the canvas so the
    // compositor surface (WebRender framebuffer) matches.
    LayoutDeviceIntRect b = widget->GetBounds();
    if (b.width != width || b.height != height) {
      widget->Resize(mozilla::DesktopSize((float)width, (float)height), true);
      resized = true;
    }
  }
  // Kick the WebRender display-list rebuild once (and after a resize). SchedulePaint
  // sets NS_FRAME_UPDATE_LAYER_TREE on the display root; the refresh driver then
  // paints + composites on its next tick -- and on every later content invalidation
  // -- so the main scene presents without a per-frame forced paint.
  static bool kicked = false;
  if (!kicked || resized) {
    kicked = true;
    if (nsIFrame* root = ps->GetRootFrame()) root->SchedulePaint();
  }
}

// GPU mode: popups are kept off the GPU (their widgets use the fallback renderer
// via HeadlessWidget::ShouldUseOffMainThreadCompositing) so they never present to
// the single page <canvas> and fight the main window's compositor. Instead we
// paint the visible popups here into a transparent, canvas-sized BGRA buffer that
// the JS side draws onto a 2D overlay canvas stacked over the WebGL canvas. Returns
// null when no popup is open, which tells JS to clear the overlay.
//
// OWNERSHIP: the returned buffer MUST be a fresh heap allocation -- the command
// loop stores it in g_cmd->result and free()s g_cmd->result at the start of the
// next command. A previous version returned a reused static buffer, which the loop
// then free()d every frame: gpu_present's PaintSynchronously/PumpEvents reallocated
// into that freed region, the next frame memset+painted into it (use-after-free)
// and re-freed it (double-free), corrupting the heap. The fault surfaced far away
// (e.g. the GC write barrier hitting "unreachable") and only in GPU mode, since the
// software path (xul_paint) already calloc's a fresh buffer each frame.
uint8_t* paint_popup_overlay(int width, int height, int32_t* outLen) {
  using namespace mozilla;
  using namespace mozilla::gfx;
  if (outLen) *outLen = 0;
  if (HostWantsPopups()) return paint_popup_windows(width, height, outLen);
  if (!g_docShell) return nullptr;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return nullptr;
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (!pm) return nullptr;
  nsTArray<nsMenuPopupFrame*> popups;
  pm->GetVisiblePopups(popups);
  if (popups.IsEmpty()) return nullptr;  // nothing open -> JS clears the overlay

  size_t need = (size_t)width * (size_t)height * 4;
  if (need == 0) return nullptr;
  uint8_t* buf = (uint8_t*)calloc(need, 1);  // zero == fully transparent backdrop
  if (!buf) return nullptr;

  int32_t stride = width * 4;
  RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
      BackendType::SKIA, buf, IntSize(width, height), stride,
      SurfaceFormat::B8G8R8A8);
  if (!dt) { free(buf); return nullptr; }
  UniquePtr<gfxContext> ctx = gfxContext::CreateOrNull(dt);
  if (!ctx) { free(buf); return nullptr; }
  int n = composite_visible_popups(ctx.get(), ps, width, height,
                                   AppUnitsPerCSSPixel());
  if (n <= 0) { free(buf); return nullptr; }  // popups vanished mid-paint
  if (outLen) *outLen = (int32_t)need;
  return buf;  // caller stores in g_cmd->result and free()s it next command
}

// Run the event loop briefly so any handlers/microtasks fired by an input event
// settle (and async layout updates land) before we repaint. Uses pending-event
// processing rather than SpinEventLoopUntil so it can't block waiting for an
// event that never comes.
void PumpEvents() {
  NS_ProcessPendingEvents(nullptr, PR_MillisecondsToInterval(30));
  if (g_docShell) {
    if (mozilla::PresShell* ps = g_docShell->GetPresShell()) {
      if (auto* d = ps->GetDocument()) {
        d->FlushPendingNotifications(mozilla::FlushType::Layout);
      }
    }
  }
}
