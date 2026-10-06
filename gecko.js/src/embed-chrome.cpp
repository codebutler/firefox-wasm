// Host chrome syscalls: nsIPrompt factory → Module.geckoOnPrompt.
// Split from embed-xul.cpp. See embed-xul.h.
#include "embed-xul.h"
#include "nsIPrompt.h"
#include "nsISupportsPrimitives.h"
#include "mozilla/Services.h"
#include "nsReadableUtils.h"
#include "nsIPromptFactory.h"
#include "nsIComponentRegistrar.h"
#include "mozilla/GenericFactory.h"
#include "mozilla/ModuleUtils.h"
#include "mozilla/SpinEventLoopUntil.h"
#include <emscripten/threading.h>
#include <atomic>
#include <cstring>

struct PromptReply {
  int32_t ok = 0;
  int32_t button = 0;
  char* value = nullptr;
  char* user = nullptr;
  char* pass = nullptr;
  ~PromptReply() { free(value); free(user); free(pass); }
};

static_assert(sizeof(PromptReply) == 20, "Host prompt protocol requires wasm32 layout");

extern "C" EMSCRIPTEN_KEEPALIVE void gecko_prompt_wake() {
  // SpinEventLoopUntil waits on Gecko's event queue, not on the completion
  // atomic. A real event must wake an idle page after the host dialog closes.
  // Capture no stack pointers: completion may already have resumed Gecko.
  NS_DispatchToMainThread(NS_NewRunnableFunction("embed-prompt-wake", []() {}));
}

static void HostPromptJson(const nsACString& json, PromptReply& reply, const char* callback = "geckoOnPrompt") {
  std::atomic<int32_t> done{0};
  // Gecko runs on a pthread; the embedder's callback and dialog UI live on the
  // browser main thread. Return from the proxy immediately, then spin Gecko's
  // event loop until the asynchronous host result is published atomically.
  MAIN_THREAD_EM_ASM({
    var request = UTF8ToString($0);
    var donePtr = $1;
    var resultPtr = $2;
    var callback = UTF8ToString($3);
    var finish = function() {
      if (Module.geckoDisposed) return;
      Atomics.store(HEAP32, donePtr >> 2, 1);
      Atomics.notify(HEAP32, donePtr >> 2, 1);
      Module['_gecko_prompt_wake']();
    };
    var copy = function(value, offset) {
      if (value == null) return;
      var bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
      var ptr = Module['_malloc'](bytes.length + 1);
      if (!ptr) throw new Error('Prompt result allocation failed');
      HEAPU32[(resultPtr + offset) >> 2] = ptr;
      HEAPU8.set(bytes, ptr);
      HEAPU8[ptr + bytes.length] = 0;
    };
    Promise.resolve().then(function() {
      if (Module.geckoDisposed) return {ok: false};
      var fn = Module[callback];
      return typeof fn === 'function' ? fn(JSON.parse(request)) : {ok: false};
    }).then(function(r) {
      if (Module.geckoDisposed) return;
      r = r || {};
      copy(r.value, 8);
      copy(r.user, 12);
      copy(r.pass, 16);
      HEAP32[resultPtr >> 2] = r.ok ? 1 : 0;
      HEAP32[(resultPtr + 4) >> 2] = r.button | 0;
      finish();
    }).catch(function() {
      if (Module.geckoDisposed) return;
      HEAP32[resultPtr >> 2] = 0;
      finish();
    });
  }, json.BeginReading(), &done, &reply, callback);
  bool completed = mozilla::SpinEventLoopUntil("embed-prompt"_ns, [&]() {
    return done.load(std::memory_order_acquire) != 0;
  });
  // A thread shutdown can stop the event loop before the host settles its
  // promise. Keep the result storage alive until that final write completes.
  if (!completed) {
    while (!done.load(std::memory_order_acquire)) {
      emscripten_futex_wait(&done, 0, 100);
    }
  }
}

static void SetPromptString(char16_t** destination, const char* value) {
  free(*destination);
  *destination = ToNewUnicode(NS_ConvertUTF8toUTF16(value ? value : ""));
}

static void JsonEscPrompt(const char16_t* in, nsACString& out) {
  NS_ConvertUTF16toUTF8 u(in ? in : u"");
  for (uint32_t i = 0; i < u.Length(); i++) {
    unsigned char c = static_cast<unsigned char>(u[i]);
    switch (c) {
      case '"': out.AppendLiteral("\\\""); break;
      case '\\': out.AppendLiteral("\\\\"); break;
      case '\n': out.AppendLiteral("\\n"); break;
      case '\r': out.AppendLiteral("\\r"); break;
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

class EmbedPrompt final : public nsIPrompt {
 public:
  EmbedPrompt() = default;
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROMPT
 private:
  ~EmbedPrompt() = default;
};

NS_IMPL_ISUPPORTS(EmbedPrompt, nsIPrompt)

NS_IMETHODIMP
EmbedPrompt::Alert(const char16_t* aTitle, const char16_t* aText) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"alert\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\"}");
  PromptReply reply;
  HostPromptJson(json, reply);
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::AlertCheck(const char16_t* aTitle, const char16_t* aText,
                        const char16_t*, bool*) {
  return Alert(aTitle, aText);
}

NS_IMETHODIMP
EmbedPrompt::Confirm(const char16_t* aTitle, const char16_t* aText,
                     bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"confirm\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\"}");
  PromptReply reply;
  HostPromptJson(json, reply);
  *aConfirm = reply.ok != 0;
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::ConfirmCheck(const char16_t* aTitle, const char16_t* aText,
                          const char16_t*, bool*, bool* aConfirm) {
  return Confirm(aTitle, aText, aConfirm);
}

NS_IMETHODIMP
EmbedPrompt::ConfirmEx(const char16_t* aTitle, const char16_t* aText,
                       uint32_t aFlags, const char16_t* b0, const char16_t* b1,
                       const char16_t* b2, const char16_t*, bool*,
                       int32_t* aButton) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"confirmEx\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\",\"flags\":");
  json.AppendInt(aFlags);
  json.AppendLiteral(",\"button0\":\"");
  JsonEscPrompt(b0, json);
  json.AppendLiteral("\",\"button1\":\"");
  JsonEscPrompt(b1, json);
  json.AppendLiteral("\",\"button2\":\"");
  JsonEscPrompt(b2, json);
  json.AppendLiteral("\"}");
  PromptReply reply;
  HostPromptJson(json, reply);
  *aButton = reply.button;
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::Prompt(const char16_t* aTitle, const char16_t* aText,
                    char16_t** aValue, const char16_t*, bool*, bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"prompt\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\",\"defaultValue\":\"");
  JsonEscPrompt(*aValue, json);
  json.AppendLiteral("\"}");
  PromptReply reply;
  HostPromptJson(json, reply);
  *aConfirm = reply.ok != 0;
  if (reply.ok) SetPromptString(aValue, reply.value);
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::PromptPassword(const char16_t* aTitle, const char16_t* aText,
                            char16_t** aPassword, bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"userPass\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\"}");
  PromptReply reply;
  HostPromptJson(json, reply);
  *aConfirm = reply.ok != 0;
  if (reply.ok) SetPromptString(aPassword, reply.pass);
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::PromptUsernameAndPassword(const char16_t* aTitle,
                                       const char16_t* aText,
                                       char16_t** aUser, char16_t** aPassword,
                                       bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"userPass\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\",\"user\":\"");
  JsonEscPrompt(*aUser, json);
  json.AppendLiteral("\"}");
  PromptReply reply;
  HostPromptJson(json, reply);
  *aConfirm = reply.ok != 0;
  if (reply.ok) {
    SetPromptString(aUser, reply.user);
    SetPromptString(aPassword, reply.pass);
  }
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::Select(const char16_t*, const char16_t*,
                    const nsTArray<nsString>&, int32_t* aOut, bool* aConfirm) {
  *aOut = 0;
  *aConfirm = false;
  return NS_ERROR_NOT_IMPLEMENTED;
}

class EmbedPromptFactory final : public nsIPromptFactory {
 public:
  EmbedPromptFactory() = default;
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROMPTFACTORY
 private:
  ~EmbedPromptFactory() = default;
};

NS_IMPL_ISUPPORTS(EmbedPromptFactory, nsIPromptFactory)

NS_IMETHODIMP
EmbedPromptFactory::GetPrompt(mozIDOMWindowProxy*, const nsIID& aIID,
                              void** aResult) {
  RefPtr<EmbedPrompt> p = new EmbedPrompt();
  return p->QueryInterface(aIID, aResult);
}

NS_GENERIC_FACTORY_CONSTRUCTOR(EmbedPromptFactory)

#define EMBED_PROMPT_CID \
  {0x6c2e9f10, 0x7a11, 0x4b2c, {0x9d, 0x33, 0x1e, 0x5a, 0x88, 0xc4, 0x01, 0xaa}}

// Privileged picker components share the host roundtrip without masquerading as
// page prompts. Content cannot access this observer or the response string.
class EmbedPickerObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_IMETHOD Observe(nsISupports* subject, const char* topic,
                     const char16_t* data) override {
    if (!strcmp(topic, "gecko-embed-picker-cancel")) {
      NS_ConvertUTF16toUTF8 id(data);
      MAIN_THREAD_EM_ASM({
        if (Module['geckoCancelPicker']) Module['geckoCancelPicker'](UTF8ToString($0));
      }, id.get());
      return NS_OK;
    }
    nsCOMPtr<nsISupportsString> result = do_QueryInterface(subject);
    if (!result) return NS_ERROR_INVALID_ARG;
    PromptReply reply;
    HostPromptJson(NS_ConvertUTF16toUTF8(data), reply, "geckoOnPicker");
    return result->SetData(NS_ConvertUTF8toUTF16(
        reply.ok && reply.value ? reply.value : "null"));
  }
 private:
  ~EmbedPickerObserver() = default;
};
NS_IMPL_ISUPPORTS(EmbedPickerObserver, nsIObserver)

// A save destination is represented by an opaque request ID. Only completed
// temporary guest files cross to the host, in bounded binary copies (no JSON
// encoding of the payload and no host filesystem paths in Gecko).
class EmbedSaveObserver final : public nsIObserver {
 public:
  NS_DECL_ISUPPORTS
  NS_IMETHOD Observe(nsISupports* subject, const char* topic,
                     const char16_t* data) override {
    NS_ConvertUTF16toUTF8 json(data);
    if (!strcmp(topic, "gecko-embed-save-cancel")) {
      MAIN_THREAD_EM_ASM({ Module['geckoCancelSave']?.(JSON.parse(UTF8ToString($0)).id); }, json.get());
      return NS_OK;
    }
    if (!strcmp(topic, "gecko-embed-save-choose")) {
      nsCOMPtr<nsISupportsString> result = do_QueryInterface(subject);
      if (!result) return NS_ERROR_INVALID_ARG;
      PromptReply reply;
      HostPromptJson(json, reply, "geckoChooseSave");
      return result->SetData(NS_ConvertUTF8toUTF16(reply.ok && reply.value ? reply.value : "null"));
    }
    nsCOMPtr<nsIFile> file = do_QueryInterface(subject);
    if (file) {
      nsAutoCString path;
      nsresult rv = file->GetNativePath(path);
      FILE* input = NS_SUCCEEDED(rv) ? fopen(path.get(), "rb") : nullptr;
      bool failed = !input;
      if (input) {
        uint8_t chunk[65536];
        size_t count;
        while ((count = fread(chunk, 1, sizeof(chunk), input))) {
          MAIN_THREAD_EM_ASM({
            Module['geckoSaveChunk']?.(JSON.parse(UTF8ToString($0)).id, HEAPU8.slice($1, $1 + $2));
          }, json.get(), chunk, count);
        }
        failed = ferror(input);
        fclose(input);
      }
      if (failed) {
        MAIN_THREAD_EM_ASM({
          Module['geckoSaveError']?.(JSON.parse(UTF8ToString($0)).id, 'Could not read the completed download.');
        }, json.get());
      }
    }
    PromptReply reply;
    HostPromptJson(json, reply, "geckoFinishSave");
    return NS_OK;
  }
 private:
  ~EmbedSaveObserver() = default;
};
NS_IMPL_ISUPPORTS(EmbedSaveObserver, nsIObserver)

void RegisterEmbedChrome() {
  nsCOMPtr<nsIObserverService> observers = mozilla::services::GetObserverService();
  if (observers) {
    RefPtr<EmbedPickerObserver> picker = new EmbedPickerObserver();
    observers->AddObserver(picker, "gecko-embed-picker", false);
    observers->AddObserver(picker, "gecko-embed-picker-cancel", false);
    RefPtr<EmbedSaveObserver> save = new EmbedSaveObserver();
    observers->AddObserver(save, "gecko-embed-save-choose", false);
    observers->AddObserver(save, "gecko-embed-save-cancel", false);
    observers->AddObserver(save, "gecko-embed-save-finish", false);
  }
  nsCOMPtr<nsIComponentRegistrar> reg;
  NS_GetComponentRegistrar(getter_AddRefs(reg));
  if (!reg) return;
  static NS_DEFINE_CID(kCid, EMBED_PROMPT_CID);
  RefPtr<mozilla::GenericFactory> fac =
      new mozilla::GenericFactory(EmbedPromptFactoryConstructor);
  nsresult rv = reg->RegisterFactory(kCid, "EmbedPromptFactory",
                                     "@mozilla.org/prompter;1", fac);
  printf("xul_init: registered EmbedPromptFactory rv=0x%08x\n", (unsigned)rv);
  fflush(stdout);
}
