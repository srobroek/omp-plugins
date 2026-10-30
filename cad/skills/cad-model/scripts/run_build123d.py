# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["build123d==0.13.0", "cadquery-ocp-novtk==8.0.1.1.0", "bd_warehouse==0.4.0"]
# ///
"""build123d 0.13 kernel runner for `cad_model.py run`; protocol in cadmodel/runner.py.

Not for direct use: it reads a JSON request on stdin and writes its JSON result to the file the request names.
"""

import sys

from cadmodel.runner import main

if __name__ == "__main__":
    sys.exit(main("build123d", ("build123d", "cadquery-ocp-novtk", "bd_warehouse")))
