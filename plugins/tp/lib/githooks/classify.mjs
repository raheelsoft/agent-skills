// classify.mjs — a command, and the script name it came from, as one of the gates (types, lint, format, tests, build) and the scope it covers.

// the tool decides the gate; the package script's name is only a hint when no tool is recognised
export const TOOLS = [
  [/\b(tsc|vue-tsc|svelte-check|mypy|pyright|pyre|flow check|cargo check|go vet|dialyzer|swift-format)\b/, 'types'],
  [/\b(eslint|biome (check|lint)|oxlint|ruff check|flake8|pylint|golangci-lint|staticcheck|clippy|rubocop|standard|phpstan|psalm|credo|detekt|ktlint|swiftlint)\b/, 'lint'],
  [/\b(prettier|biome format|ruff format|black|isort|gofmt|goimports|rustfmt|cargo fmt|mix format|dotnet format|php-cs-fixer|ktfmt|spotless)\b/, 'format'],
  [/\b(jest|vitest|mocha|ava|playwright test|cypress run|pytest|unittest|go test|cargo test|rspec|minitest|phpunit|pest|mix test|dotnet test|swift test|gradlew? (test|check)|mvn (test|verify)|node --test)\b/, 'tests'],
  [/\b(next build|nest build|tsup|vite build|rollup|webpack|esbuild|cargo build|go build|mix compile|dotnet build|swift build|gradlew? (assemble|build)|mvn (package|install))\b/, 'build'],
];

export const NAMES = [[/^(typecheck|type-check|types|tsc)$/, 'types'], [/^lint(:.*)?$/, 'lint'], [/^(format|fmt|prettier)(:.*)?$/, 'format'], [/^test(s)?(:.*)?$/, 'tests'], [/^build(:.*)?$/, 'build']];

export function gateOf(raw, scriptName = null) {
  const s = String(raw);
  for (const [re, gate] of TOOLS) if (re.test(s)) return gate;
  if (scriptName) for (const [re, gate] of NAMES) if (re.test(scriptName)) return gate;
  const run = /\b(?:npm run|pnpm run|yarn run|yarn|pnpm|bun run|make)\s+([\w:-]+)/.exec(s);
  if (run) for (const [re, gate] of NAMES) if (re.test(run[1])) return gate;
  return null;
}

// a command that names files (or is driven by lint-staged) only covers those files
export function scopeOf(raw, viaLintStaged) {
  if (viaLintStaged) return 'staged';
  return /(\$\{?[@1*]|"\$@"|--staged\b|\bgit diff --name-only\b)/.test(String(raw)) ? 'staged' : 'repo';
}
