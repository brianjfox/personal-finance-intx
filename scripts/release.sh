#!/usr/bin/env bash
# Cut a release (docs/RELEASING.md): stamp the version everywhere it
# lives, commit, tag vX.Y.Z, and push. The tag push runs
# .github/workflows/release.yml, which builds the universal macOS .dmg
# and the Windows installer and opens a DRAFT GitHub release with
# docs/releases/X.Y.Z.md as its notes.
#
#   scripts/release.sh X.Y.Z[-pre.N] [--no-push] [--dry-run]
#
# Preconditions it enforces: on main, clean tree, in sync with
# origin/main, docs/releases/X.Y.Z.md committed, tag unused.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"; PUSH=1; DRY=0
shift || true
for a in "$@"; do
  case "$a" in
    --no-push) PUSH=0 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "usage: scripts/release.sh X.Y.Z[-pre.N] [--no-push] [--dry-run]" >&2; exit 2
fi
TAG="v$VERSION"
CONF="apps/desktop/src-tauri/tauri.conf.json"
CARGO="apps/desktop/src-tauri/Cargo.toml"
LOCK="apps/desktop/src-tauri/Cargo.lock"
NOTES="docs/releases/$VERSION.md"

fail() { echo "release: $*" >&2; exit 1; }

# --- preconditions --------------------------------------------------------
[ "$(git branch --show-current)" = "main" ] || fail "releases are cut from main"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"
git fetch --quiet origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not in sync with origin/main (pull or push first)"
git ls-files --error-unmatch "$NOTES" >/dev/null 2>&1 || fail "$NOTES must exist and be committed first (docs(release): add perfi $VERSION release notes)"
grep -q "^# Corbits Personal Finance $VERSION\$" "$NOTES" || fail "$NOTES must start with '# Corbits Personal Finance $VERSION'"
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || fail "tag $TAG already exists locally"
! git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 || fail "tag $TAG already exists on origin"
CURRENT="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$CONF")"
[ -n "$CURRENT" ] || fail "cannot read version from $CONF"
[ "$CURRENT" != "$VERSION" ] || fail "$CONF is already at $VERSION"

echo "release: $CURRENT -> $VERSION (tag $TAG)"
if [ "$DRY" = 1 ]; then echo "release: dry run, nothing changed"; exit 0; fi

# --- stamp the version ----------------------------------------------------
# tauri.conf.json is the single source of truth (the bundle and the About
# popup read it); Cargo.toml/Cargo.lock are kept in step so `cargo` agrees.
sed -i '' "s/^  \"version\": \"$CURRENT\",\$/  \"version\": \"$VERSION\",/" "$CONF"
sed -i '' "s/^version = \".*\"\$/version = \"$VERSION\"/" "$CARGO"   # only [package] has a bare version line
sed -i '' "/^name = \"financial-interchange\"\$/{n;s/^version = \".*\"\$/version = \"$VERSION\"/;}" "$LOCK"
grep -q "\"version\": \"$VERSION\"" "$CONF" || fail "failed to stamp $CONF"
grep -q "^version = \"$VERSION\"" "$CARGO" || fail "failed to stamp $CARGO"
grep -A1 '^name = "financial-interchange"$' "$LOCK" | grep -q "version = \"$VERSION\"" || fail "failed to stamp $LOCK"

git add "$CONF" "$CARGO" "$LOCK"
git commit --quiet -m "chore(release): perfi $VERSION"
git tag -a "$TAG" -m "Corbits Personal Finance $VERSION"
echo "release: committed $(git rev-parse --short HEAD) and tagged $TAG"

if [ "$PUSH" = 1 ]; then
  git push origin main "$TAG"
  REPO="$(git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')"
  echo "release: pushed. Watch the build:  gh run watch  (or https://github.com/$REPO/actions)"
  echo "release: when it is green, review and publish the draft:"
  echo "         gh release view $TAG --web"
  echo "         gh release edit $TAG --draft=false"
else
  echo "release: not pushed. When ready:  git push origin main $TAG"
fi
