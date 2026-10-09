# Local Voice Notices

Whisper.cpp and the downloaded tiny.en Whisper model are distributed under MIT licenses. The immutable base image is an upstream main build, not a relabeled release build.

This optional locally built image also installs espeak-ng, a standalone GPL-3.0-or-later executable, and distribution ffmpeg/Python packages under their upstream licenses. They are separate executables invoked by the runner; they are not relabeled under Simurgh's Apache license. Redistributors must preserve applicable package notices and satisfy corresponding source obligations. See https://github.com/ggml-org/whisper.cpp and https://github.com/espeak-ng/espeak-ng.

## Cleanup Limit

The coordinator attempts `docker rm -f` for the exact owned container after every operation, with a bounded cleanup grace. Verified tests establish removal while the local Docker daemon is healthy. A Docker daemon failure or timeout can prevent confirming removal; killing its CLI does not guarantee that the container stopped. An operator must check and remove remaining `simurgh-voice-*` containers after such a failure. These isolated containers retain the same no-network, read-only, resource-limited configuration; temporary audio may remain in their tmpfs until removal or daemon restart. Cleanup is not guaranteed during a Docker daemon outage.
