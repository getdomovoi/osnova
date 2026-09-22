#!/usr/bin/env python3
"""Dump a FastAPI application's route table as the oracle for osnova's routes edges.

Run inside the checkout's own environment, from the directory that holds the package:
    uv run python /path/to/osnova/scripts/route-oracle-fastapi.py app.api.main:api_router > routes.json
The argument is module:attribute of an APIRouter or FastAPI instance. Routers included through
include_router are walked with their prefixes, so every path is the full mounted path. Each row
carries the endpoint's source file (relative to the parent of the working directory) and the
first line of its decorated definition, which is the line osnova records the edge at.
"""
import importlib
import inspect
import json
import os
import sys

from fastapi.routing import APIRoute

module_name, attribute = sys.argv[1].split(":")
router = getattr(importlib.import_module(module_name), attribute)
root = os.path.abspath(os.path.join(os.getcwd(), ".."))
rows = []


def walk(node, prefix):
    for route in node.routes:
        if isinstance(route, APIRoute):
            endpoint = inspect.unwrap(route.endpoint)
            rows.append({
                "methods": sorted(route.methods),
                "path": prefix + route.path,
                "endpoint": endpoint.__name__,
                "file": os.path.relpath(inspect.getsourcefile(endpoint), root),
                "line": inspect.getsourcelines(endpoint)[1],
            })
        elif hasattr(route, "original_router"):
            context = vars(route.include_context)
            walk(route.original_router, prefix + str(context.get("prefix") or ""))
        elif hasattr(route, "routes"):
            walk(route, prefix)


walk(router, "")
json.dump(rows, sys.stdout, indent=1)
sys.stdout.write("\n")
