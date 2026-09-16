#!/usr/bin/env bash
greet() { format "$1"; }
format() { printf '%s\n' "$1"; }
greet x
