.DEFAULT_GOAL := help

.PHONY: help install build typecheck test check
help:
	@printf 'install    Install development tools\nbuild      Build the installable extension\ntypecheck  Check TypeScript\ntest       Run tests; narrow with TEST=path\ncheck      Typecheck, test and build\n'

install:
	bun install --frozen-lockfile

build:
	bun build src/index.ts --target browser --outfile index.js

typecheck:
	bunx tsc --noEmit

test:
	bun test $(TEST)

check: typecheck test build
