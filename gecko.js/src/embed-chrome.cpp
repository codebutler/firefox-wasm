// Host chrome syscalls: nsIPrompt factory → Module.geckoOnPrompt.
// Split from embed-xul.cpp. See embed-xul.h.
#include "embed-xul.h"
#include "nsIPrompt.h"
#include "nsIPromptFactory.h"
#include "nsIComponentRegistrar.h"
#include "mozilla/GenericFactory.h"
#include "mozilla/ModuleUtils.h"
#include "mozilla/SpinEventLoopUntil.h"
#include <atomic>
#include <cstring>

static bool HostPromptJson(const nsACString& json, bool* aOk, nsACString* aValue,
                           int32_t* aButton) {
  int32_t done = 0;
  int32_t status = 0;
  int32_t button = 0;
  char value[4096];
  value[0] = 0;
  EM_ASM(
      {
        var json = UTF8ToString($0);
        var donePtr = $1, statusPtr = $2, valuePtr = $3, valueCap = $4,
            buttonPtr = $5;
        var fn = (typeof Module !== 'undefined') ? Module['geckoOnPrompt'] : null;
        var p = (typeof fn === 'function') ? fn(JSON.parse(json))
                                           : Promise.resolve({ok : true});
        Promise.resolve(p)
            .then(function(r) {
              r = r || {};
              HEAP32[statusPtr >> 2] = r.ok ? 1 : 0;
              HEAP32[buttonPtr >> 2] = (r.button | 0);
              if (valuePtr && r.value != null) {
                var u = unescape(encodeURIComponent(String(r.value)));
                var n = Math.min(u.length, valueCap - 1);
                for (var i = 0; i < n; i++)
                  HEAPU8[valuePtr + i] = u.charCodeAt(i) & 0xff;
                HEAPU8[valuePtr + n] = 0;
              }
              Atomics.store(HEAP32, donePtr >> 2, 1);
              Atomics.notify(HEAP32, donePtr >> 2, 1);
            })
            .catch(function() {
              HEAP32[statusPtr >> 2] = 0;
              Atomics.store(HEAP32, donePtr >> 2, 1);
              Atomics.notify(HEAP32, donePtr >> 2, 1);
            });
      },
      json.BeginReading(), &done, &status, value, 4096, &button);
  mozilla::SpinEventLoopUntil("embed-prompt"_ns, [&]() { return done != 0; });
  if (aOk) *aOk = status != 0;
  if (aValue && value[0]) aValue->Assign(value);
  if (aButton) *aButton = button;
  return true;
}

static void JsonEscPrompt(const nsAString& in, nsACString& out) {
  NS_ConvertUTF16toUTF8 u(in);
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
EmbedPrompt::Alert(const nsAString& aTitle, const nsAString& aText) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"alert\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\"}");
  bool ok = false;
  HostPromptJson(json, &ok, nullptr, nullptr);
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::AlertCheck(const nsAString& aTitle, const nsAString& aText,
                        const nsAString&, bool*) {
  return Alert(aTitle, aText);
}

NS_IMETHODIMP
EmbedPrompt::Confirm(const nsAString& aTitle, const nsAString& aText,
                     bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"confirm\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\"}");
  bool ok = false;
  HostPromptJson(json, &ok, nullptr, nullptr);
  *aConfirm = ok;
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::ConfirmCheck(const nsAString& aTitle, const nsAString& aText,
                          const nsAString&, bool*, bool* aConfirm) {
  return Confirm(aTitle, aText, aConfirm);
}

NS_IMETHODIMP
EmbedPrompt::ConfirmEx(const nsAString& aTitle, const nsAString& aText,
                       uint32_t aFlags, const nsAString& b0, const nsAString& b1,
                       const nsAString& b2, const nsAString&, bool*,
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
  bool ok = false;
  int32_t button = 0;
  HostPromptJson(json, &ok, nullptr, &button);
  *aButton = button;
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::Prompt(const nsAString& aTitle, const nsAString& aText,
                    nsAString& aValue, const nsAString&, bool*, bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"prompt\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\",\"defaultValue\":\"");
  JsonEscPrompt(aValue, json);
  json.AppendLiteral("\"}");
  bool ok = false;
  nsCString out;
  HostPromptJson(json, &ok, &out, nullptr);
  *aConfirm = ok;
  if (ok) CopyUTF8toUTF16(out, aValue);
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::PromptPassword(const nsAString& aTitle, const nsAString& aText,
                            nsAString& aPassword, const nsAString&, bool*,
                            bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"userPass\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\"}");
  bool ok = false;
  nsCString out;
  HostPromptJson(json, &ok, &out, nullptr);
  *aConfirm = ok;
  if (ok) CopyUTF8toUTF16(out, aPassword);
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::PromptUsernameAndPassword(const nsAString& aTitle,
                                       const nsAString& aText,
                                       nsAString& aUser, nsAString& aPassword,
                                       const nsAString&, bool*, bool* aConfirm) {
  nsCString json;
  json.AssignLiteral("{\"kind\":\"userPass\",\"title\":\"");
  JsonEscPrompt(aTitle, json);
  json.AppendLiteral("\",\"message\":\"");
  JsonEscPrompt(aText, json);
  json.AppendLiteral("\",\"user\":\"");
  JsonEscPrompt(aUser, json);
  json.AppendLiteral("\"}");
  bool ok = false;
  nsCString out;
  HostPromptJson(json, &ok, &out, nullptr);
  *aConfirm = ok;
  // handlePrompt returns user/pass separately; C++ value field is unused here.
  (void)aPassword;
  (void)out;
  return NS_OK;
}

NS_IMETHODIMP
EmbedPrompt::Select(const nsAString&, const nsAString&,
                    const nsTArray<nsString>&, int32_t* aOut) {
  *aOut = 0;
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

void RegisterEmbedChrome() {
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
