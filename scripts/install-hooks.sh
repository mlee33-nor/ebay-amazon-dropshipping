#!/bin/sh
# Railway deploys every push to main, so a push must never ship code that fails the tests. Run once per clone.
cd "$(git rev-parse --show-toplevel)" || exit 1
cat > .git/hooks/pre-push <<'HOOK'
#!/bin/sh
echo "Running every test suite before pushing (Railway deploys on push)..."
TEST_PG_OFFSET=${TEST_PG_OFFSET:-900} sh scripts/test-all.sh || { echo "Tests failed: push stopped. Fix them or push with --no-verify if you really must."; exit 1; }
HOOK
chmod +x .git/hooks/pre-push
echo "pre-push hook installed"
