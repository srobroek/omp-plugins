# Steering recipes, imported by the root justfile.
#
# The generator is a pure function of the tree: no prompts and no network, so CI verifies
# it rather than trusting it. Everything outside the markers survives, and a file with no
# marker is never written after it is first created, which is what keeps conventions.md.

# Regenerate the marked blocks in docs/agents/
[group('steering')]
steering:
    @python3 scripts/gen_steering.py .

# Fail when docs/agents/ no longer describes the tree
[group('steering')]
steering-check:
    @python3 scripts/gen_steering.py . --check
