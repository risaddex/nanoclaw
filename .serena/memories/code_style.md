---
name: Code style and conventions
description: TypeScript style, formatting rules, naming conventions
type: project
---

- **Quotes:** single quotes (prettier singleQuote: true)
- **TypeScript:** strict mode, ES2022, NodeNext modules, .js extensions in imports
- **No comments** unless the WHY is non-obvious (invariant, workaround, hidden constraint)
- **No docstrings** — well-named identifiers are self-documenting
- **Imports:** .js extension required for local imports (NodeNext resolution)
- **ESM:** type: "module" — use import/export, not require()
- **Pre-commit:** husky runs format:fix automatically on commit
- **Naming:** camelCase functions/vars, PascalCase types/interfaces, UPPER_SNAKE for constants
