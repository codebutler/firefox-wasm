/* weval proof-of-mechanism: a tiny bytecode interpreter that we specialize
 * per-program via weval, in the style of SpiderMonkey's pbl-weval branch.
 *
 * Flow:
 *   1. weval_init() runs at Wizer snapshot time: picks a "hot program",
 *      enqueues a weval request for `interpret` specialized on its bytecode.
 *   2. weval fills interpret_specialized with a copy of `interpret` where the
 *      bytecode array is a compile-time constant -> dispatch+operands fold.
 *   3. At run time, `dispatch` calls the specialized fn when available.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "weval.h"

WEVAL_DEFINE_GLOBALS()

typedef int32_t (*interp_t)(const uint8_t* code, uint32_t len, int32_t arg);

/* A toy bytecode: PUSH c / LOAD / ADD / MUL / RET over a 4-slot stack.
 * The interpreter loop is written so that, once `code` is a compile-time
 * constant buffer, weval can constant-fold the whole program. */
enum { OP_PUSH = 1, OP_LOAD = 2, OP_ADD = 3, OP_MUL = 4, OP_RET = 5 };

__attribute__((noinline))
static int32_t interpret_impl(const uint8_t* code, uint32_t len, int32_t arg) {
  int32_t stack[8];
  int sp = 0;
  for (uint32_t pc = 0; pc < len;) {
    weval_push_context(pc); /* tell weval "control state = pc" */
    uint8_t op = code[pc++];
    switch (op) {
      case OP_PUSH: stack[sp++] = code[pc++]; break;
      case OP_LOAD: stack[sp++] = arg; break;
      case OP_ADD: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a + b; } break;
      case OP_MUL: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a * b; } break;
      case OP_RET: weval_pop_context(); return stack[--sp];
      default: return -9999;
    }
    weval_pop_context();
  }
  return -8888;
}

/* The request slot weval fills in: declared as a function pointer so the
 * call site is indirect (generic vs specialized chosen at runtime). */
static interp_t g_specialized = NULL;

static int32_t interpret(const uint8_t* code, uint32_t len, int32_t arg) {
  if (g_specialized) {
    return g_specialized(code, len, arg);
  }
  return interpret_impl(code, len, arg);
}

/* Program: computes arg*arg + 7  ==  PUSH arg, LOAD arg, MUL, PUSH 7, ADD */
static const uint8_t PROG[] = { OP_LOAD, OP_LOAD, OP_MUL, OP_PUSH, 7, OP_ADD, OP_RET };

__attribute__((export_name("wizer.initialize")))
void wizer_initialize(void) {
  /* Snapshot-time: enqueue "specialize interpret_impl to PROG". */
  weval::weval(&g_specialized, &interpret_impl, /*func_id*/ 1,
               /*num_globals*/ 0,
               weval::SpecializeMemory(&PROG[0], (uint32_t)sizeof(PROG)),
               weval::Specialize<uint32_t>((uint32_t)sizeof(PROG)),
               weval::Runtime<int32_t>());
}

__attribute__((export_name("run")))
int32_t run(int32_t arg, int32_t iters) {
  int32_t acc = 0;
  for (int32_t i = 0; i < iters; i++) {
    acc += interpret(PROG, (uint32_t)sizeof(PROG), arg + i);
  }
  return acc;
}

/* marker so wizer has a init fn + trivial main for embedders that need one */
int main(void) { return 0; }
