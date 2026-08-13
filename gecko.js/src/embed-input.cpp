// Input injection (synthesized mouse/keyboard/wheel) + clipboard priming. Split
// from embed-xul.cpp. See embed-xul.h.
#include "embed-xul.h"
#include "mozilla/dom/Selection.h"
#include "nsIContent.h"
#include "nsIRollupListener.h"

static bool HostWantsNewWindow() {
  return EM_ASM_INT({
           return (typeof Module !== 'undefined' &&
                   typeof Module['geckoOnNewWindow'] === 'function')
                      ? 1
                      : 0;
         }) != 0;
}

// Consume left-clicks on <a target=_blank|_new> and ask the host to open a
// window. Gecko has one docshell; it cannot host a second content window.
static bool MaybeHostBlankTarget(mozilla::PresShell* ps, int x, int y) {
  using namespace mozilla;
  if (!HostWantsNewWindow() || !ps) return false;
  int32_t a = AppUnitsPerCSSPixel();
  nsPoint rootPt(x * a, y * a);
  nsIContent* content = nullptr;
  if (nsIFrame* root = ps->GetRootFrame()) {
    if (nsIFrame* target =
            nsLayoutUtils::GetFrameForPoint(RelativeTo{root}, rootPt)) {
      content = target->GetContent();
    }
  }
  nsAutoCString spec;
  for (nsIContent* n = content; n; n = n->GetParent()) {
    if (!n->IsHTMLElement(nsGkAtoms::a)) continue;
    nsAutoString tgt;
    if (n->IsElement()) {
      n->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::target, tgt);
    }
    if (!(tgt.LowerCaseEqualsLiteral("_blank") ||
          tgt.LowerCaseEqualsLiteral("_new"))) {
      continue;
    }
    if (nsGenericHTMLElement* html = nsGenericHTMLElement::FromNode(n)) {
      if (nsCOMPtr<nsIURI> href = html->GetHrefURI()) {
        href->GetSpec(spec);
      }
    }
    if (spec.IsEmpty()) continue;
    EM_ASM(
        {
          if (typeof Module !== 'undefined' &&
              typeof Module['geckoOnNewWindow'] === 'function') {
            try {
              Module['geckoOnNewWindow'](
                  {url : UTF8ToString($0), features : ""});
            } catch (e) {
            }
          }
        },
        spec.get());
    return true;
  }
  return false;
}

static bool HostWantsContextMenu() {
  return EM_ASM_INT({
           return (typeof Module !== 'undefined' &&
                   typeof Module['geckoOnContextMenu'] === 'function')
                      ? 1
                      : 0;
         }) != 0;
}

void xul_rollup() {
  if (nsXULPopupManager* pm = nsXULPopupManager::GetInstance()) {
    nsIRollupListener::RollupOptions opts;
    opts.mCount = 0;
    pm->Rollup(opts, nullptr);
  }
}

static void JsonEsc(const nsACString& in, nsACString& out) {
  for (uint32_t i = 0; i < in.Length(); i++) {
    unsigned char c = static_cast<unsigned char>(in[i]);
    switch (c) {
      case '"':
        out.AppendLiteral("\\\"");
        break;
      case '\\':
        out.AppendLiteral("\\\\");
        break;
      case '\n':
        out.AppendLiteral("\\n");
        break;
      case '\r':
        out.AppendLiteral("\\r");
        break;
      case '\t':
        out.AppendLiteral("\\t");
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          out.AppendASCII(buf);
        } else {
          out.Append(c);
        }
    }
  }
}

static void JsonStr(nsACString& json, const char* key, const nsACString& val) {
  json.AppendLiteral(",\"");
  json.AppendASCII(key);
  json.AppendLiteral("\":\"");
  JsonEsc(val, json);
  json.AppendLiteral("\"");
}

static void MaybeHostContextMenu(mozilla::PresShell* ps, int x, int y) {
  using namespace mozilla;
  if (!ps) return;

  // Page handlers run during SynthesizeMouseEvent. Read defaultPrevented from
  // a bubble-phase window listener installed just before dispatch (do_mouse).
  char* prevFlag = nullptr;
  RunChromeScript("window.__geckoCtxPrev?'1':'0'"_ns, &prevFlag);
  bool prevented = prevFlag && prevFlag[0] == '1';
  free(prevFlag);
  printf("xul: ctxmenu prevented=%d\n", (int)prevented);
  fflush(stdout);
  xul_rollup();
  // Still show the OS menu if content also handled it — better a double
  // menu than a silent right-click. (Content-drawn menus are rare.)

  nsAutoCString pageUrl;
  bool canBack = false, canForward = false;
  nsCOMPtr<nsIWebNavigation> nav = do_QueryInterface(g_docShell);
  if (nav) {
    nav->GetCanGoBack(&canBack);
    nav->GetCanGoForward(&canForward);
    nsCOMPtr<nsIURI> cur;
    if (NS_SUCCEEDED(nav->GetCurrentURI(getter_AddRefs(cur))) && cur) {
      cur->GetSpec(pageUrl);
    }
  }

  bool flLink = false, flImage = false, flMedia = false, flSel = false,
       flEdit = false;
  nsAutoCString linkUrl, linkText, imageUrl, imageAlt, mediaUrl, selText;

  int32_t a = AppUnitsPerCSSPixel();
  nsPoint rootPt(x * a, y * a);
  nsIContent* content = nullptr;
  if (nsIFrame* root = ps->GetRootFrame()) {
    if (nsIFrame* target =
            nsLayoutUtils::GetFrameForPoint(RelativeTo{root}, rootPt)) {
      content = target->GetContent();
    }
  }
  for (nsIContent* n = content; n; n = n->GetParent()) {
    if (n->IsHTMLElement(nsGkAtoms::a)) {
      if (nsGenericHTMLElement* html = nsGenericHTMLElement::FromNode(n)) {
        if (nsCOMPtr<nsIURI> href = html->GetHrefURI()) {
          href->GetSpec(linkUrl);
          flLink = !linkUrl.IsEmpty();
        }
      }
      if (linkText.IsEmpty()) {
        nsAutoString t;
        ErrorResult rv;
        n->GetTextContent(t, rv);
        rv.SuppressException();
        if (!t.IsEmpty()) {
          NS_ConvertUTF16toUTF8 u(t);
          if (u.Length() > 512) u.Truncate(512);
          linkText = u;
        }
      }
    }
    nsCOMPtr<nsIImageLoadingContent> img = do_QueryInterface(n);
    if (img) {
      nsCOMPtr<nsIURI> src;
      img->GetCurrentURI(getter_AddRefs(src));
      if (src) {
        src->GetSpec(imageUrl);
        flImage = !imageUrl.IsEmpty();
      }
      if (n->IsElement()) {
        nsAutoString alt;
        n->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::alt, alt);
        if (!alt.IsEmpty()) {
          NS_ConvertUTF16toUTF8 u(alt);
          if (u.Length() > 256) u.Truncate(256);
          imageAlt = u;
        }
      }
    }
    if (n->IsAnyOfHTMLElements(nsGkAtoms::video, nsGkAtoms::audio)) {
      nsAutoString src;
      if (n->IsElement()) {
        n->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::src, src);
      }
      if (!src.IsEmpty()) {
        NS_ConvertUTF16toUTF8 u(src);
        mediaUrl = u;
        flMedia = true;
      }
    }
    if (n->IsAnyOfHTMLElements(nsGkAtoms::input, nsGkAtoms::textarea) ||
        n->IsEditable()) {
      flEdit = true;
    }
  }

  nsCOMPtr<mozIDOMWindowProxy> winProxy = do_GetInterface(g_docShell);
  nsPIDOMWindowOuter* outer =
      winProxy ? nsPIDOMWindowOuter::From(winProxy) : nullptr;
  if (outer) {
    RefPtr<dom::Selection> sel = outer->GetSelection();
    if (sel && !sel->IsCollapsed()) {
      nsAutoString t;
      sel->Stringify(t);
      if (!t.IsEmpty()) {
        NS_ConvertUTF16toUTF8 u(t);
        if (u.Length() > 4096) u.Truncate(4096);
        selText = u;
        flSel = true;
      }
    }
  }

  nsCString json;
  json.AssignLiteral("{\"x\":");
  json.AppendInt(x);
  json.AppendLiteral(",\"y\":");
  json.AppendInt(y);
  json.AppendLiteral(",\"canBack\":");
  json.AppendASCII(canBack ? "true" : "false");
  json.AppendLiteral(",\"canForward\":");
  json.AppendASCII(canForward ? "true" : "false");
  json.AppendLiteral(",\"flags\":{");
  bool comma = false;
  auto addFlag = [&](const char* k, bool v) {
    if (!v) return;
    if (comma) json.Append(',');
    comma = true;
    json.Append('"');
    json.AppendASCII(k);
    json.AppendLiteral("\":true");
  };
  addFlag("link", flLink);
  addFlag("image", flImage);
  addFlag("media", flMedia);
  addFlag("selection", flSel);
  addFlag("editable", flEdit);
  json.Append('}');
  JsonStr(json, "pageUrl", pageUrl);
  if (flLink) JsonStr(json, "linkUrl", linkUrl);
  if (flLink && !linkText.IsEmpty()) JsonStr(json, "linkText", linkText);
  if (flImage) JsonStr(json, "imageUrl", imageUrl);
  if (flImage && !imageAlt.IsEmpty()) JsonStr(json, "imageAlt", imageAlt);
  if (flMedia) JsonStr(json, "mediaUrl", mediaUrl);
  if (flSel) JsonStr(json, "selectionText", selText);
  json.Append('}');
  printf("xul: ctxmenu json=%s\n", json.get());
  fflush(stdout);

  EM_ASM(
      {
        var s = UTF8ToString($0);
        console.log('[embed] ctxmenu ' + s);
        if (typeof Module !== 'undefined' &&
            typeof Module['geckoOnContextMenu'] === 'function') {
          try {
            Module['geckoOnContextMenu'](JSON.parse(s));
          } catch (e) {
            console.log('[embed] ctxmenu parse fail ' + e);
          }
        } else {
          console.log('[embed] no geckoOnContextMenu');
        }
      },
      json.get());
}

// Synthesize a mouse event (evType: 0 move, 1 down, 2 up) at CSS px (x,y) and
// dispatch it through the full event path (hit-testing, focus, click synthesis).
void do_mouse(int evType, int x, int y, int button, int clickCount,
                     int buttons, int modifiers) {
  using namespace mozilla;
  if (!g_docShell) return;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return;
  nsPresContext* pc = ps->GetPresContext();
  nsPoint offset;
  nsIWidget* widget = nsContentUtils::GetWidget(ps, &offset);
  if (!widget || !pc) return;

  // Outside-click rollup: native widgets roll popups up when you click off them
  // (the widget's rollup listener); the headless widget never delivers that, so do
  // it here. On a mousedown outside every open popup, roll them all up and consume
  // the click so it doesn't also fall through to content -- matching native menu
  // behavior. Clicks inside a popup fall through (menu item activation).
  if (evType == 1) {
    if (nsXULPopupManager* pm = nsXULPopupManager::GetInstance()) {
      nsTArray<nsMenuPopupFrame*> popups;
      pm->GetVisiblePopups(popups);
      if (!popups.IsEmpty()) {
        bool inside = false;
        for (auto* pf : popups) {
          if (!pf) continue;
          LayoutDeviceIntRect b = pf->CalcWidgetBounds();
          if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
            inside = true;
            break;
          }
        }
        if (!inside) {
          nsIRollupListener::RollupOptions opts;
          opts.mCount = 0;  // close all open popups
          pm->Rollup(opts, nullptr);
          return;  // consume the dismissing click
        }
      }
    }
    if (button == 0 && MaybeHostBlankTarget(ps, x, y)) return;
  }

  LayoutDeviceIntPoint ref =
      nsContentUtils::ToWidgetPoint(CSSPoint(x, y), offset, pc);
  // evType: 0=mousemove 1=mousedown 2=mouseup 3=contextmenu. A synthesized right
  // mousedown/up doesn't generate eContextMenu in this headless build, so the JS
  // side sends an explicit contextmenu event (button 2) to open context menus.
  const char* typeStr =
      evType == 1 ? "mousedown"
                  : (evType == 2 ? "mouseup"
                                 : (evType == 3 ? "contextmenu" : "mousemove"));
  nsAutoString type;
  type.AssignASCII(typeStr);

  if (evType == 3 && HostWantsContextMenu()) {
    RunChromeScript(
        "window.__geckoCtxPrev=false;"
        "window.addEventListener('contextmenu',function(e){"
        "window.__geckoCtxPrev=!!e.defaultPrevented;},{once:true});"_ns);
  }

  dom::SynthesizeMouseEventData data;
  data.mButton = button;
  data.mModifiers = modifiers;
  data.mInputSource = 1;  // MouseEvent.MOZ_SOURCE_MOUSE
  if (buttons >= 0) data.mButtons.Construct(buttons);
  if (clickCount > 0) data.mClickCount.Construct(clickCount);
  dom::SynthesizeMouseEventOptions options;  // defaults are fine
  dom::Optional<OwningNonNull<dom::VoidFunction>> noCallback;

  auto rv = nsContentUtils::SynthesizeMouseEvent(ps, widget, type, ref, data,
                                                 options, noCallback);
  (void)rv;

  if (evType == 3) {
    MaybeHostContextMenu(ps, x, y);
  }

  // Capture the cursor the content specifies under the pointer so the host page
  // can mirror it (cursor: pointer over links, text over inputs, resize handles,
  // etc.). This is what EventStateManager::UpdateCursor feeds the widget; we read
  // it back from the frame since the windowless widget's SetCursor is a no-op.
  if (g_cmd) {
    int32_t a = AppUnitsPerCSSPixel();
    nsPoint rootPt(x * a, y * a);
    int kind = (int)StyleCursorKind::Auto;
    if (nsIFrame* root = ps->GetRootFrame()) {
      if (nsIFrame* target =
              nsLayoutUtils::GetFrameForPoint(RelativeTo{root}, rootPt)) {
        nsPoint framePt = rootPt - target->GetOffsetTo(root);
        kind = (int)target->GetCursor(framePt).mCursor;
      }
    }
    g_cmd->cursor = kind;
  }
}

// Synthesize a wheel (scroll) event at CSS px (x,y) with pixel deltas, mirroring
// the tested EventUtils.synthesizeWheel path.
void do_wheel(int x, int y, double dx, double dy, int modifiers) {
  using namespace mozilla;
  if (!g_docShell) return;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return;
  nsPresContext* pc = ps->GetPresContext();
  nsPoint offset;
  nsIWidget* widget = nsContentUtils::GetWidget(ps, &offset);
  if (!widget || !pc) return;

  ScrollContainerFrame* sf = ps->GetRootScrollContainerFrame();
  nsPoint before = sf ? sf->GetScrollPosition() : nsPoint();

  WidgetWheelEvent ev(true, eWheel, widget);
  ev.mModifiers = nsContentUtils::GetWidgetModifiers(modifiers);
  ev.mDeltaX = dx;
  ev.mDeltaY = dy;
  ev.mDeltaZ = 0.0;
  ev.mDeltaMode = 0;  // WheelEvent.DOM_DELTA_PIXEL
  ev.mLineOrPageDeltaX = dx > 0 ? (int32_t)std::floor(dx) : (int32_t)std::ceil(dx);
  ev.mLineOrPageDeltaY = dy > 0 ? (int32_t)std::floor(dy) : (int32_t)std::ceil(dy);
  ev.mRefPoint = nsContentUtils::ToWidgetPoint(CSSPoint(x, y), offset, pc);

  // With APZ enabled (GPU mode), route the wheel through the APZ input bridge so the
  // scroll is handled ASYNCHRONOUSLY on the compositor (async scroll transform sampled
  // per composite) instead of a synchronous main-thread display-list rebuild. APZ owns
  // applying the scroll, so do NOT also scroll the root frame ourselves.
  static bool s_apzLogged = false;
  if (!s_apzLogged) {
    s_apzLogged = true;
    printf("do_wheel: widget AsyncPanZoomEnabled=%d\n", widget->AsyncPanZoomEnabled());
    fflush(stdout);
  }
  if (widget->AsyncPanZoomEnabled()) {
    nsIWidget::ContentAndAPZEventStatus st = widget->DispatchInputEvent(&ev);
    static int s_apzResN = 0;
    if (s_apzResN < 5) {
      s_apzResN++;
      printf("APZ-DIAG do_wheel result: apzStatus=%d contentStatus=%d\n",
             (int)st.mApzStatus, (int)st.mContentStatus);
      fflush(stdout);
    }
    return;
  }

  // Non-APZ (software) path: the dispatched wheel event is "consumed" by the event
  // manager (eConsumeNoDefault) but the scroll isn't applied. If the position didn't
  // move and content didn't preventDefault (e.g. a custom scroller / map), apply the
  // scroll to the root scroll frame ourselves. Use Smooth mode so the GPU compositor
  // animates it over refresh-driver ticks.
  widget->DispatchEvent(&ev);
  if (sf && sf->GetScrollPosition() == before && !ev.DefaultPrevented()) {
    sf->ScrollToCSSPixels(
        CSSPoint::FromAppUnits(before) + CSSPoint((float)dx, (float)dy),
        ScrollMode::Smooth);
  }
}

// Build + dispatch one keyboard event of the given message through the widget.
static void dispatch_key(nsIWidget* widget, mozilla::EventMessage msg,
                         const nsAString& key, int keyCode, int charCode,
                         int modifiers) {
  using namespace mozilla;
  WidgetKeyboardEvent ev(true, msg, widget);
  KeyNameIndex kni = WidgetKeyboardEvent::GetKeyNameIndex(key);
  ev.mKeyNameIndex = kni;
  if (kni == KEY_NAME_INDEX_USE_STRING) ev.mKeyValue = key;
  ev.mCodeNameIndex = CODE_NAME_INDEX_UNKNOWN;
  ev.mModifiers = nsContentUtils::GetWidgetModifiers(modifiers);
  if (msg == eKeyPress && charCode) {
    // Printable keypress: mCharCode gates text insertion (IsInputtingText),
    // mKeyValue carries the inserted string; DOM keyCode is 0 for printables.
    ev.mCharCode = charCode;
    ev.mKeyCode = 0;
  } else {
    ev.mKeyCode = keyCode ? keyCode
                          : (kni != KEY_NAME_INDEX_USE_STRING
                                 ? WidgetKeyboardEvent::
                                       ComputeKeyCodeFromKeyNameIndex(kni)
                                 : 0);
  }
  widget->DispatchEvent(&ev);
}

// Synthesize a keyboard event (evType: 0 keydown, 1 keyup). On keydown, also
// dispatch a keypress for non-modifier keys (matching DOM ordering), which is
// what drives text insertion + editor commands.
void do_key(int evType, const char* keyUtf8, int keyCode, int charCode,
                   int modifiers) {
  using namespace mozilla;
  if (!g_docShell) return;
  PresShell* ps = g_docShell->GetPresShell();
  if (!ps) return;
  nsPoint offset;
  nsIWidget* widget = nsContentUtils::GetWidget(ps, &offset);
  if (!widget) return;

  NS_ConvertUTF8toUTF16 key(keyUtf8);
  KeyNameIndex kni = WidgetKeyboardEvent::GetKeyNameIndex(key);
  bool isModifierKey = WidgetKeyboardEvent::GetModifierForKeyName(kni) !=
                       MODIFIER_NONE;
  if (evType == 0) {
    dispatch_key(widget, eKeyDown, key, keyCode, 0, modifiers);
    if (!isModifierKey) {
      dispatch_key(widget, eKeyPress, key, keyCode, charCode, modifiers);
    }
  } else {
    dispatch_key(widget, eKeyUp, key, keyCode, 0, modifiers);
  }
}

// Store UTF-8 text on the global clipboard via the normal nsIClipboard path (the
// headless clipboard). Used to prime the clipboard from the system clipboard
// (navigator.clipboard) just before a native paste; see OP 9 / pasteThenKey in the
// JS loader. HeadlessClipboard::SetNativeClipboardData also mirrors back out to
// navigator.clipboard, which for a paste is the same text -- harmless.
bool set_clipboard_text(const char* utf8) {
  using namespace mozilla;
  if (!utf8) return false;
  nsCOMPtr<nsIClipboard> clipboard =
      do_GetService("@mozilla.org/widget/clipboard;1");
  if (!clipboard) return false;
  nsCOMPtr<nsITransferable> trans =
      do_CreateInstance("@mozilla.org/widget/transferable;1");
  if (!trans) return false;
  trans->Init(nullptr);
  trans->AddDataFlavor(kTextMime);
  nsCOMPtr<nsISupportsString> data =
      do_CreateInstance("@mozilla.org/supports-string;1");
  if (!data) return false;
  data->SetData(NS_ConvertUTF8toUTF16(utf8));
  trans->SetTransferData(kTextMime, ToSupports(data));
  return NS_SUCCEEDED(
      clipboard->SetData(trans, nullptr, nsIClipboard::kGlobalClipboard, nullptr));
}
