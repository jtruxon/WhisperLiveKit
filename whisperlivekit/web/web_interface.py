import base64
import importlib.resources as resources
import logging

logger = logging.getLogger(__name__)


def _inline_svg_in_text(text: str, svg_filename: str, data_url: str) -> str:
    """Replace every reference to ``src/<svg_filename>`` in the bundled text
    with the corresponding base64 data URL. Used so SVG references inside
    bundled JS template strings (e.g. dynamically built history items)
    pick up the inlined images, not 404s.
    """
    return text.replace(f'src="src/{svg_filename}"', f'src="{data_url}"')


def get_web_interface_html():
    """Loads the HTML for the web interface using importlib.resources."""
    try:
        with resources.files('whisperlivekit.web').joinpath('live_transcription.html').open('r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        logger.error(f"Error loading web interface HTML: {e}")
        return "<html><body><h1>Error loading interface</h1></body></html>"

def get_inline_ui_html():
    """Returns the complete web interface HTML with all assets embedded in a single call."""
    try:
        with resources.files('whisperlivekit.web').joinpath('live_transcription.html').open('r', encoding='utf-8') as f:
            html_content = f.read()
        with resources.files('whisperlivekit.web').joinpath('live_transcription.css').open('r', encoding='utf-8') as f:
            css_content = f.read()
        with resources.files('whisperlivekit.web').joinpath('live_transcription.js').open('r', encoding='utf-8') as f:
            js_content = f.read()

        with resources.files('whisperlivekit.web').joinpath('pcm_worklet.js').open('r', encoding='utf-8') as f:
            worklet_code = f.read()
        with resources.files('whisperlivekit.web').joinpath('recorder_worker.js').open('r', encoding='utf-8') as f:
            worker_code = f.read()
        with resources.files('whisperlivekit.web').joinpath('mp3_encoder_worker.js').open('r', encoding='utf-8') as f:
            encoder_worker_code = f.read()

        js_content = js_content.replace(
            'await audioContext.audioWorklet.addModule("/web/pcm_worklet.js");',
            'const workletBlob = new Blob([`' + worklet_code + '`], { type: "application/javascript" });\n' +
            'const workletUrl = URL.createObjectURL(workletBlob);\n' +
            'await audioContext.audioWorklet.addModule(workletUrl);'
        )
        js_content = js_content.replace(
            'recorderWorker = new Worker("/web/recorder_worker.js");',
            'const workerBlob = new Blob([`' + worker_code + '`], { type: "application/javascript" });\n' +
            'const workerUrl = URL.createObjectURL(workerBlob);\n' +
            'recorderWorker = new Worker(workerUrl);'
        )
        js_content = js_content.replace(
            'mp3EncoderWorker = new Worker("/web/mp3_encoder_worker.js");',
            'const encoderBlob = new Blob([`' + encoder_worker_code + '`], { type: "application/javascript" });\n' +
            'const encoderUrl = URL.createObjectURL(encoderBlob);\n' +
            'mp3EncoderWorker = new Worker(encoderUrl);'
        )

        # SVG files
        with resources.files('whisperlivekit.web').joinpath('src', 'system_mode.svg').open('r', encoding='utf-8') as f:
            system_svg = f.read()
            system_data_uri = f"data:image/svg+xml;base64,{base64.b64encode(system_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'light_mode.svg').open('r', encoding='utf-8') as f:
            light_svg = f.read()
            light_data_uri = f"data:image/svg+xml;base64,{base64.b64encode(light_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'dark_mode.svg').open('r', encoding='utf-8') as f:
            dark_svg = f.read()
            dark_data_uri = f"data:image/svg+xml;base64,{base64.b64encode(dark_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'settings.svg').open('r', encoding='utf-8') as f:
            settings = f.read()
            settings_uri = f"data:image/svg+xml;base64,{base64.b64encode(settings.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'clipboard.svg').open('r', encoding='utf-8') as f:
            clipboard_svg = f.read()
            clipboard_uri = f"data:image/svg+xml;base64,{base64.b64encode(clipboard_svg.encode('utf-8')).decode('utf-8')}"

        # New SVG files for history panel
        with resources.files('whisperlivekit.web').joinpath('src', 'history.svg').open('r', encoding='utf-8') as f:
            history_svg = f.read()
            history_uri = f"data:image/svg+xml;base64,{base64.b64encode(history_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'play.svg').open('r', encoding='utf-8') as f:
            play_svg = f.read()
            play_uri = f"data:image/svg+xml;base64,{base64.b64encode(play_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'pause.svg').open('r', encoding='utf-8') as f:
            pause_svg = f.read()
            pause_uri = f"data:image/svg+xml;base64,{base64.b64encode(pause_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'trash.svg').open('r', encoding='utf-8') as f:
            trash_svg = f.read()
            trash_uri = f"data:image/svg+xml;base64,{base64.b64encode(trash_svg.encode('utf-8')).decode('utf-8')}"
        with resources.files('whisperlivekit.web').joinpath('src', 'arrow_back.svg').open('r', encoding='utf-8') as f:
            arrow_back_svg = f.read()
            arrow_back_uri = f"data:image/svg+xml;base64,{base64.b64encode(arrow_back_svg.encode('utf-8')).decode('utf-8')}"

        # Replace external references
        html_content = html_content.replace(
            '<link rel="stylesheet" href="live_transcription.css" />',
            f'<style>\n{css_content}\n</style>'
        )

        html_content = html_content.replace(
            '<script src="live_transcription.js"></script>',
            f'<script>\n{js_content}\n</script>'
        )

        # Replace SVG references
        html_content = html_content.replace(
            '<img src="/web/src/system_mode.svg" alt="" />',
            f'<img src="{system_data_uri}" alt="" />'
        )

        html_content = html_content.replace(
            '<img src="/web/src/light_mode.svg" alt="" />',
            f'<img src="{light_data_uri}" alt="" />'
        )

        html_content = html_content.replace(
            '<img src="/web/src/dark_mode.svg" alt="" />',
            f'<img src="{dark_data_uri}" alt="" />'
        )

        html_content = html_content.replace(
            '<img src="web/src/settings.svg" alt="Settings" />',
            f'<img src="{settings_uri}" alt="" />'
        )

        html_content = html_content.replace(
            '<img src="src/clipboard.svg" alt="Copy" width="20" height="20" />',
            f'<img src="{clipboard_uri}" alt="Copy" width="20" height="20" />'
        )

        # New history panel SVG replacements
        html_content = html_content.replace(
            '<img src="src/history.svg" alt="History" width="20" height="20" />',
            f'<img src="{history_uri}" alt="History" width="20" height="20" />'
        )

        html_content = html_content.replace(
            '<img src="src/arrow_back.svg" alt="Back" width="20" height="20" />',
            f'<img src="{arrow_back_uri}" alt="Back" width="20" height="20" />'
        )

        html_content = html_content.replace(
            '<img src="src/trash.svg" alt="Clear All" width="18" height="18" />',
            f'<img src="{trash_uri}" alt="Clear All" width="18" height="18" />'
        )

        html_content = html_content.replace(
            '<img src="src/play.svg" alt="Play" width="22" height="22"',
            f'<img src="{play_uri}" alt="Play" width="22" height="22"'
        )

        html_content = html_content.replace(
            '<img src="src/pause.svg" alt="Pause" width="22" height="22"',
            f'<img src="{pause_uri}" alt="Pause" width="22" height="22"'
        )

        html_content = html_content.replace(
            '<img src="src/clipboard.svg" alt="Copy" width="16" height="16" />',
            f'<img src="{clipboard_uri}" alt="Copy" width="16" height="16" />'
        )

        html_content = html_content.replace(
            '<img src="src/trash.svg" alt="Delete" width="16" height="16" />',
            f'<img src="{trash_uri}" alt="Delete" width="16" height="16" />'
        )

        # Also replace SVG references in the inlined JS (used in renderHistoryList template literals)
        html_content = _inline_svg_in_text(html_content, "clipboard.svg", clipboard_uri)
        html_content = _inline_svg_in_text(html_content, "trash.svg", trash_uri)

        return html_content

    except Exception as e:
        logger.error(f"Error creating embedded web interface: {e}")
        return "<html><body><h1>Error loading embedded interface</h1></body></html>"


if __name__ == '__main__':

    import pathlib

    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse
    from starlette.staticfiles import StaticFiles

    import whisperlivekit.web as webpkg

    app = FastAPI()
    web_dir = pathlib.Path(webpkg.__file__).parent
    app.mount("/web", StaticFiles(directory=str(web_dir)), name="web")

    @app.get("/")
    async def get():
        return HTMLResponse(get_inline_ui_html())

    uvicorn.run(app=app)
