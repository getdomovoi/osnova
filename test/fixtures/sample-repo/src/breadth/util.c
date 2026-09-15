#include <stdio.h>

#define LIMIT 3

struct Point { int x; int y; };

enum Mode { FAST, SLOW };

static int helper(int v) {
  return v + LIMIT;
}

int compute(int a) {
  int b = helper(a);
  printf("%d\n", b);
  return b;
}
