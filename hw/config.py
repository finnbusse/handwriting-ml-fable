"""Project-wide defaults."""

# Whose handwriting the model is trained on.  Recordings of the capture app carry
# a writer id (a slug of the name typed in the app); the older datasets have none
# and all belong to this writer.  Train another writer with
#   python -m hw.train --writer <slug> --no-legacy
MAIN_WRITER = "finn"
