/* Wasm extension probe: tail-call (return_call_indirect) dispatch vs
 * switch dispatch for a no-codegen bytecode interpreter.
 *
 * Program executed:  acc = 0; for (i = 0; i < N; i++) acc += i;
 * Bytecode:
 *   LIT 0 STORE 0        ; i = 0
 *   LIT 0 STORE 1        ; acc = 0
 * loop:
 *   LOADL 0 LOADARG LT JZ end
 *   LOADL 1 LOADL 0 ADD STORE 1
 *   LOADL 0 LIT 1 ADD STORE 0
 *   JMP loop
 * end:
 *   LOADL 1 RET
 */
#include <stdint.h>
#include <stdio.h>

enum {
  OP_LIT = 1,     /* imm8 */
  OP_LOADARG,     /* push arg */
  OP_LOADL,       /* imm8: local idx -> push */
  OP_STORE,       /* imm8: pop -> local idx */
  OP_ADD,         /* pop b, pop a, push a+b */
  OP_LT,          /* pop b, pop a, push a<b */
  OP_JZ,          /* imm8 addr: pop cond, if 0 pc=addr */
  OP_JMP,         /* imm8 addr: pc=addr */
  OP_RET,         /* return pop */
};

/* loop over i<arg; acc += i */
#define PROG \
  { \
    OP_LIT, 0, OP_STORE, 0,                  /* i = 0    */ \
    OP_LIT, 0, OP_STORE, 1,                  /* acc = 0  */ \
    /* loop @8: */                           \
    OP_LOADL, 0, OP_LOADARG, OP_LT, OP_JZ,   \
    30,                                      /* i<n? else->30 */ \
    OP_LOADL, 1, OP_LOADL, 0, OP_ADD, OP_STORE, 1, /* acc+=i */ \
    OP_LOADL, 0, OP_LIT, 1, OP_ADD, OP_STORE, 0,   /* i++    */ \
    OP_JMP, 8,                               /* ->loop   */ \
    /* end @30: */                           \
    OP_LOADL, 1, OP_RET                      /* ret acc  */ \
  }

static const volatile uint8_t PROG_BYTES[] = PROG;

/* ---------------- switch-dispatch interpreter ---------------- */

__attribute__((noinline)) static int32_t
interp_switch(const volatile uint8_t* code, int32_t arg) {
  int32_t stack[16];
  int32_t locals[8];
  int sp = 0;
  uint32_t pc = 0;
  for (;;) {
    switch (code[pc++]) {
      case OP_LIT: stack[sp++] = code[pc++]; break;
      case OP_LOADARG: stack[sp++] = arg; break;
      case OP_LOADL: stack[sp++] = locals[code[pc++]]; break;
      case OP_STORE: locals[code[pc++]] = stack[--sp]; break;
      case OP_ADD: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a + b; } break;
      case OP_LT: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a < b; } break;
      case OP_JZ: { uint32_t t = code[pc++]; if (!stack[--sp]) pc = t; } break;
      case OP_JMP: pc = code[pc]; break;
      case OP_RET: return stack[--sp];
      default: return -9999;
    }
  }
}

/* ---------------- tail-call-dispatch interpreter ---------------- */

typedef struct {
  const volatile uint8_t* code;
  uint32_t pc;
  int32_t arg;
  int32_t stack[16];
  int32_t locals[8];
  int sp;
  int32_t result;
} St;

typedef void (*Handler)(St*);
static Handler handlers[16];

#define NEXT()                                    \
  do {                                            \
    [[clang::musttail]]                           \
    return handlers[s->code[s->pc++]](s);         \
  } while (0)

static void h_lit(St* s) {
  s->stack[s->sp++] = s->code[s->pc++];
  NEXT();
}
static void h_loadarg(St* s) {
  s->stack[s->sp++] = s->arg;
  NEXT();
}
static void h_loadl(St* s) {
  s->stack[s->sp++] = s->locals[s->code[s->pc++]];
  NEXT();
}
static void h_store(St* s) {
  s->locals[s->code[s->pc++]] = s->stack[--s->sp];
  NEXT();
}
static void h_add(St* s) {
  int32_t b = s->stack[--s->sp], a = s->stack[--s->sp];
  s->stack[s->sp++] = a + b;
  NEXT();
}
static void h_lt(St* s) {
  int32_t b = s->stack[--s->sp], a = s->stack[--s->sp];
  s->stack[s->sp++] = a < b;
  NEXT();
}
static void h_jz(St* s) {
  uint32_t t = s->code[s->pc++];
  if (!s->stack[--s->sp]) s->pc = t;
  NEXT();
}
static void h_jmp(St* s) {
  s->pc = s->code[s->pc];
  NEXT();
}
static void h_ret(St* s) {
  s->result = s->stack[--s->sp];
  /* no tail call: unwind */
}

__attribute__((noinline)) static int32_t
interp_tailcall(const volatile uint8_t* code, int32_t arg) {
  static int init = 0;
  if (!init) {
    handlers[OP_LIT] = h_lit;
    handlers[OP_LOADARG] = h_loadarg;
    handlers[OP_LOADL] = h_loadl;
    handlers[OP_STORE] = h_store;
    handlers[OP_ADD] = h_add;
    handlers[OP_LT] = h_lt;
    handlers[OP_JZ] = h_jz;
    handlers[OP_JMP] = h_jmp;
    handlers[OP_RET] = h_ret;
    init = 1;
  }
  St s = {code, 0, arg, {0}, {0}, 0, 0};
  handlers[s.code[s.pc++]](&s);
  return s.result;
}

/* ---------------- benchmark harness ---------------- */

__attribute__((export_name("run_switch"))) int32_t
run_switch(int32_t arg, int32_t iters) {
  int32_t acc = 0;
  for (int32_t i = 0; i < iters; i++) {
    acc = (int32_t)((int64_t)acc + interp_switch(PROG_BYTES, arg));
  }
  return acc;
}

__attribute__((export_name("run_tailcall"))) int32_t
run_tailcall(int32_t arg, int32_t iters) {
  int32_t acc = 0;
  for (int32_t i = 0; i < iters; i++) {
    acc = (int32_t)((int64_t)acc + interp_tailcall(PROG_BYTES, arg));
  }
  return acc;
}

int main(void) { return 0; }
