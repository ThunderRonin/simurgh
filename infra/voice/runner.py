import json
import os
import subprocess
import sys
import tempfile


def invoke(argv, timeout=12):
    subprocess.run(argv, check=True, timeout=timeout, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def main():
    mode = sys.argv[1]
    data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('Input exceeds limit')
    with tempfile.TemporaryDirectory(dir='/tmp', prefix='simurgh-') as temp:
        audio = os.path.join(temp, 'input')
        wave = os.path.join(temp, 'audio.wav')
        if mode == 'transcribe':
            with open(audio, 'wb') as output:
                output.write(data)
            # MediaRecorder WebM often omits duration; inspect bounded decoded audio.
            decoded = os.path.join(temp, 'decoded.wav')
            invoke(['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', audio,
                    '-t', '31', '-ar', '16000', '-ac', '1', '-y', decoded], 4)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                                    '-show_entries', 'format=duration', '-of', 'json', decoded],
                                   check=True, timeout=3, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
            duration = float(json.loads(probe.stdout)['format']['duration'])
            if not 0 < duration <= 30.25:
                raise ValueError('Audio duration exceeds limit')
            invoke(['ffmpeg', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', decoded,
                    '-t', '30', '-ar', '16000', '-ac', '1', '-y', wave], 4)
            prefix = os.path.join(temp, 'result')
            invoke(['whisper-cli', '-m', '/models/ggml-tiny.en.bin', '-f', wave,
                    '-oj', '-of', prefix, '-t', '2', '-nt'], 12)
            with open(prefix + '.json', encoding='utf8') as result:
                text = ''.join(segment['text'] for segment in json.load(result)['transcription']).strip()
            if not text or len(text) > 4000:
                raise ValueError('No bounded transcript')
            sys.stdout.write(json.dumps({'text': text}))
        elif mode == 'speech':
            text = data.decode('utf8')
            if not text or len(text) > 1000:
                raise ValueError('Invalid speech text')
            subprocess.run(['espeak-ng', '-v', 'en-us', '-s', '175', '--stdin', '-w', wave],
                           input=data, check=True, timeout=12, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
            with open(wave, 'rb') as result:
                output = result.read(4 * 1024 * 1024 + 1)
            if len(output) > 4 * 1024 * 1024:
                raise ValueError('Speech exceeds limit')
            sys.stdout.buffer.write(output)
        else:
            raise ValueError('Unknown operation')


try:
    main()
except Exception:
    sys.stderr.write('Local voice operation failed\n')
    sys.exit(1)
