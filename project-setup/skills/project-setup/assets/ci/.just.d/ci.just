# CI recipes, imported by the root justfile.
#
# A reusable workflow does not run itself, and which ones exist depends on which asset
# sets were applied, so the caller is derived from the directory rather than written by
# hand. Run this after adopting a language. It refuses a ci.yml carrying no generator
# marker, which is how a repository takes the file over.

# Rebuild .github/workflows/ci.yml from the wc-* workflows beside it
[group('ci')]
ci-sync:
    @python3 scripts/gen_caller.py .
