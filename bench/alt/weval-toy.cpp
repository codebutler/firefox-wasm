/* weval proof-of-mechanism: a tiny bytecode interpreter specialized
 * per-program via weval, mirroring SpiderMonkey's pbl-weval approach.
 * Canonical pattern per weval's own tests/simple.cpp:
 *   Interpret<true> = specialization target (const bytecode via
 *   SpecializeMemory); push_context(pc0) once; update_context(next) per
 *   dispatch/goto; Interpret<false> = runtime fallback.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "weval.h"

WEVAL_DEFINE_GLOBALS()

enum Op : uint32_t { OP_PUSH, OP_GETL, OP_SETL, OP_ADD, OP_MUL, OP_SUB,
                     OP_GOTO, OP_JNZ, OP_RET };

struct Inst { uint32_t op; int32_t imm; };
struct State { int32_t stack[16]; int32_t locals[8]; };

template <bool Specialized>
static int32_t Interpret(const Inst* insts, uint32_t ninsts, State* state,
                         int32_t arg) {
  uint32_t pc = 0;
  int32_t* stack = state->stack;
  int32_t* locals = state->locals;
  int sp = 0;
  locals[0] = arg;
  if (Specialized) weval::push_context(pc);
  while (true) {
    const Inst* inst = &insts[pc];
    pc++;
    if (Specialized) weval::update_context(pc);
    switch (inst->op) {
      case OP_PUSH: stack[sp++] = inst->imm; break;
      case OP_GETL: stack[sp++] = locals[inst->imm]; break;
      case OP_SETL: locals[inst->imm] = stack[--sp]; break;
      case OP_ADD: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a + b; } break;
      case OP_MUL: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a * b; } break;
      case OP_SUB: { int32_t b = stack[--sp], a = stack[--sp]; stack[sp++] = a - b; } break;
      case OP_GOTO:
        pc = (uint32_t)inst->imm;
        if (Specialized) weval::update_context(pc);
        break;
      case OP_JNZ:
        if (stack[--sp] != 0) {
          pc = (uint32_t)inst->imm;
          if (Specialized) weval::update_context(pc);
        }
        break;
      case OP_RET: goto out;
      default: goto out;
    }
  }
out:
  if (Specialized) weval::pop_context();
  return locals[2];
}

typedef int32_t (*InterpretFunc)(const Inst*, uint32_t, State*, int32_t);
WEVAL_DEFINE_TARGET(1, Interpret<true>);

/* acc = sum_{i=0}^{63} arg^2 * i  (= arg^2 * 2016); i/acc in locals[1]/[2]. */
static const Inst PROG[] = {
    {OP_PUSH, 0},   {OP_SETL, 1},            // i = 0
    {OP_PUSH, 0},   {OP_SETL, 2},            // acc = 0
    /*4*/ {OP_GETL, 1}, {OP_PUSH, 64}, {OP_SUB, 0},
    {OP_JNZ, 9},                             // if i-64: body @9
    {OP_RET, 0},
    /*9*/ {OP_GETL, 2}, {OP_GETL, 0}, {OP_GETL, 0}, {OP_MUL, 0},
    {OP_GETL, 1}, {OP_MUL, 0},               // arg^2 * i
    {OP_ADD, 0}, {OP_SETL, 2},               // acc += it
    {OP_GETL, 1}, {OP_PUSH, 1}, {OP_ADD, 0}, {OP_SETL, 1},
    {OP_GOTO, 4},
};

static InterpretFunc g_specialized = nullptr;

__attribute__((export_name("wizer.initialize")))
extern "C" void wizer_initialize(void) {
  weval::weval(&g_specialized, &Interpret<true>, /*func_id*/ 1, 0,
               weval::SpecializeMemory<const Inst*>(&PROG[0], sizeof(PROG)),
               weval::Specialize<uint32_t>((uint32_t)(sizeof(PROG) / sizeof(Inst))),
               weval::Runtime<State*>(), weval::Runtime<int32_t>());
}

extern "C" __attribute__((export_name("run")))
int32_t run(int32_t arg, int32_t iters) {
  State state;
  int32_t acc = 0;
  const uint32_t n = (uint32_t)(sizeof(PROG) / sizeof(Inst));
  for (int32_t i = 0; i < iters; i++) {
    int32_t r = g_specialized
        ? g_specialized(&PROG[0], n, &state, arg + i)
        : Interpret<false>(&PROG[0], n, &state, arg + i);
    acc += r;
  }
  return acc;
}

extern "C" int main(void) { return 0; }
