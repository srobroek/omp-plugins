"""Decision and image parity policy shared by render caching and comparison."""

POLICY_VERSION = "render-pixel-parity-exact-v1"
# Measured on pace at 1600x1200, exact commit f29cc933fe: two serial runs and
# serial-vs-jobs2 matched all 30 images. Max channel delta=0, p99.9=0, changed pixels=0%.
MAX_PIXEL_CHANNEL_DELTA = 0
MIN_IDENTICAL_PIXEL_FRACTION = 1.0


def cache_key() -> dict[str, int | float | str]:
    """Invalidate render manifests whenever the parity acceptance contract changes."""
    return {
        "version": POLICY_VERSION,
        "max_pixel_channel_delta": MAX_PIXEL_CHANNEL_DELTA,
        "min_identical_pixel_fraction": MIN_IDENTICAL_PIXEL_FRACTION,
    }
