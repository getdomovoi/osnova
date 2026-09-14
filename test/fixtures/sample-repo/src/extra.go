package main

import (
	"fmt"
	"strings"
)

type Pair struct {
	A, B int
}

type Stringer interface {
	String() string
}

func Reverse(s string) string {
	return strings.ToUpper(s)
}
