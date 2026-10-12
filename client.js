/**
 * dsh-vision-bridge — Web-UI client half.
 *
 * Hand-written bundle: the harness serves this file as the package's `./client`
 * export and the web shell registers it through `window.__ModuleLoader__.load`.
 * There is no build step and no bundler; the factory's module requests are only
 * the shell's frozen platform table entries `react` and `react-dom`, so
 * everything else is plain browser API.
 *
 * It registers ONE visual object — a composer-dock pill named "Vision inbox" —
 * that:
 *  - shows how many images the per-project inbox currently holds, and
 *  - opens a floating panel (portaled to `document.body`, fixed above the pill)
 *    that reads `GET /dsh-vision-bridge/inbox`, uploads through
 *    `POST /dsh-vision-bridge/upload`, and offers the honest delete refusal of
 *    `POST /dsh-vision-bridge/remove`.
 *
 * Configuration is deliberately NOT here: the harness's native settings form
 * renders this plugin's Config for free, and duplicating those inputs would give
 * two sources of truth.
 *
 * Every path is fail-safe: a missing route, a failed fetch, or a malformed
 * payload renders an explicit message instead of blanking the slot.
 */

(function () {
  'use strict'
  if (typeof window === 'undefined') return
  var loader = window.__ModuleLoader__
  if (!loader || typeof loader.load !== 'function') return

  // The literal loader call below is the client-module contract the shell's
  // diagnostics look for (`bundle ... loaded without registering "<id>"`), and
  // its id must equal the package name, because the graph row's id is what the
  // registration is matched against. `loader` above only guards the early exit;
  // a classic script cannot `return` at the top level, hence the IIFE.
  window.__ModuleLoader__.load({
    id: 'dsh-vision-bridge',
    factory: function (require) {
      var React = require('react')
      // `react-dom` is a shell platform module exactly like `react` (the frozen
      // module table): shipped client bundles resolve it the same way, and its
      // `createPortal` is what keeps this panel out of the composer's layout.
      var ReactDOM = require('react-dom')
      var createPortal = ReactDOM && ReactDOM.createPortal
      var h = React.createElement

      /** Frozen HTTP contract of the host half. */
      var INBOX_PATH = '/dsh-vision-bridge/inbox'
      var UPLOAD_PATH = '/dsh-vision-bridge/upload'
      var REMOVE_PATH = '/dsh-vision-bridge/remove'

      /** Distance kept between the pill and the panel floating above it. */
      var PANEL_GAP = 8
      /** Distance kept between the panel and each viewport edge. */
      var PANEL_MARGIN = 12
      /**
       * Unplaced portal style: hidden but laid out, so the first placement pass
       * measures real panel dimensions instead of a zero-height guess (the
       * harness's own `MEASURE_STYLE`).
       */
      var MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
      /** How long the "copied" confirmation stays on a Copy path button. */
      var COPY_RESET_MS = 1600

      /**
       * Every user-visible string, in one frozen object, so localization is a
       * later mechanical change (v1 is English-only — see docs/GUI.md).
       */
      var STRINGS = Object.freeze({
        pill: 'Vision inbox',
        pillCount: 'Images',
        imagesWord: 'images',
        title: 'Vision inbox',
        close: 'Close',
        retry: 'Retry',
        loading: 'Loading the inbox…',
        loadFailed: 'Could not load the inbox.',
        statusHeading: 'Status',
        labelInbox: 'Inbox',
        labelProjectDir: 'Project',
        labelRoute: 'Vision route',
        labelRouteState: 'Route state',
        labelAgents: 'Sub-agents',
        labelTasks: 'Tasks',
        routeUnset: 'not configured',
        routeReady: 'ready',
        routeNotReady: 'not usable',
        unset: 'none',
        uploadHeading: 'Upload',
        zoneLegend: 'Image kind',
        zoneReference: 'Design / mockup (user-authored)',
        zoneCapture: 'Screenshot (app evidence)',
        chooseFiles: 'Choose images',
        upload: 'Upload',
        uploading: 'Uploading…',
        uploaded: 'Uploaded',
        noFiles: 'Select one or more PNG, JPEG, WebP or GIF files.',
        uploadsUnsupported: 'Uploads are unavailable in this profile: no attachment store is mounted.',
        readFailed: 'Could not read',
        imagesHeading: 'Images',
        zoneEmpty: 'no images in this zone',
        empty: 'No images yet. Upload one above, or drop files into the inbox folder.',
        sourceFolder: 'folder',
        sourceUpload: 'upload',
        copyPath: 'Copy path',
        copied: 'Copied',
        copyFailed: 'Copy failed — select the path text and copy it manually.',
        remove: 'Remove…',
        removeAria: 'Remove…',
        cannotDelete: 'Deleting is not supported by this plugin.',
        cannotDeleteShort: 'Remove the file yourself from the inbox folder.',
        footer: 'Configure the route, tasks, inbox and cache in Settings → Plugins → dsh-vision-bridge.',
      })

      /** The two inbox zones, in display order, with their selector labels. */
      var ZONES = [
        { id: 'reference', label: STRINGS.zoneReference },
        { id: 'capture', label: STRINGS.zoneCapture },
      ]

      // The dock entry itself is only this small in-flow row plus the pill; the
      // panel is a FLOATING surface, never a row child. As an in-flow child of
      // this dock row the panel stretched the composer bar and pushed the
      // message box and bottom bar up the page (live report 2026-10-12 on the
      // sibling plugin), and `position: fixed` alone is not enough: composer
      // ancestors use `backdrop-filter`/`transform` and clip with `overflow`, so
      // a fixed element inside them is still trapped. Fixed + portaled to
      // <body> keeps it out of the layout, out of every containing block and
      // clip, and above the app's layers; the harness tokens make it read as the
      // same surface family as the context ring's dialog.
      //
      // SURFACE FILL: the family fill token, --dsw-specific-menu, is the shared
      // MENU material and is deliberately translucent (45-58% alpha; the 94%
      // variant applies only to macOS). The panel layers it OVER an opaque
      // raised-layer token so transcript text cannot show through, and applies
      // the harness menu blur token too (a no-op wherever the theme leaves it
      // unset).
      var CSS = [
        '.dshvb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font:inherit;color:inherit}',
        '.dshvb-anchor{display:inline-flex;min-width:0;',
        'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
        'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
        '.dshvb-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;',
        'padding:1px 8px;border:none;border-radius:999px;background:transparent;',
        'color:var(--dsw-alias-label-tertiary,inherit);font:inherit;line-height:inherit;',
        'white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}',
        '.dshvb-pill:hover,.dshvb-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,transparent);',
        'color:var(--dsw-alias-label-secondary,inherit)}',
        '.dshvb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#247bbf);flex:none}',
        '.dshvb-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
        '.dshvb-panel{position:fixed;z-index:1100;box-sizing:border-box;',
        'width:min(460px,calc(100vw - 24px));max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain;',
        'padding:14px 16px;display:grid;gap:12px;border:0;border-radius:var(--dsw-radius-lg,10px);',
        'background:var(--dsw-specific-menu,#1b1d22) var(--dsw-alias-bg-layer-1,#1b1d22);',
        'backdrop-filter:var(--dsw-menu-backdrop-filter,none);',
        '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
        'box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.45));',
        'color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:18px}',
        '.dshvb-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.dshvb-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
        '.dshvb-section{display:grid;gap:6px;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2,currentColor)}',
        '.dshvb-section h5{margin:0;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshvb-kv{display:grid;grid-template-columns:minmax(84px,auto) minmax(0,1fr);gap:4px 12px;margin:0}',
        '.dshvb-kv dt{color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshvb-kv dd{margin:0;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,inherit)}',
        '.dshvb-path{display:block;margin:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;',
        'color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}',
        '.dshvb-note{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);margin:0}',
        '.dshvb-bad{color:var(--dsw-alias-state-error-primary,#f85149)}',
        '.dshvb-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}',
        '.dshvb-button{border:1px solid var(--dsw-alias-border-l1,currentColor);border-radius:var(--dsw-radius-sm,8px);',
        'background:transparent;color:inherit;font:inherit;font-size:11px;padding:3px 10px;cursor:pointer}',
        '.dshvb-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,transparent)}',
        '.dshvb-button:disabled{opacity:.5;cursor:default}',
        '.dshvb-zone{display:grid;gap:4px;margin:0;padding:0;border:0}',
        '.dshvb-zone legend{padding:0;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshvb-choice{display:flex;align-items:center;gap:6px;font-size:11px}',
        '.dshvb-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dshvb-file{max-width:100%;font:inherit;font-size:11px;color:inherit}',
        '.dshvb-results{display:grid;gap:3px;margin:0;padding:0;list-style:none;font-size:11px}',
        '.dshvb-groups{display:grid;gap:10px}',
        '.dshvb-group{display:grid;gap:4px}',
        '.dshvb-zone-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
        'font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit)}',
        '.dshvb-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}',
        '.dshvb-item{display:grid;gap:4px;padding:8px;border:0.5px solid var(--dsw-alias-border-l2,currentColor);',
        'border-radius:var(--dsw-radius-sm,8px)}',
        '.dshvb-item-head{display:flex;align-items:baseline;gap:8px;min-width:0}',
        '.dshvb-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;',
        'color:var(--dsw-alias-label-primary,inherit)}',
        '.dshvb-badge{border:0.5px solid var(--dsw-alias-border-l1,currentColor);border-radius:999px;padding:0 6px;',
        'font-size:10px;color:var(--dsw-alias-label-tertiary,inherit);flex:none}',
        '.dshvb-footer{margin:0;padding-top:10px;border-top:0.5px solid var(--dsw-alias-border-l2,currentColor);',
        'font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}',
        '.dshvb-pill,.dshvb-button{transition:background-color var(--ds-transition-duration-fast,120ms) var(--ds-ease-in-out,ease)}',
        '@media (prefers-reduced-motion: reduce){.dshvb-pill,.dshvb-button{transition:none}}',
      ].join('')

      /**
       * Bytes as a short human-readable size (1.5 KB, 2 MB).
       * @param bytes - the file size, ignored when not a finite number.
       * @returns the display string.
       */
      function formatBytes(bytes) {
        var value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
        if (value < 1024) return value + ' B'
        var units = ['KB', 'MB', 'GB']
        var scaled = value
        var unit = 'B'
        for (var index = 0; index < units.length && scaled >= 1024; index += 1) {
          scaled = scaled / 1024
          unit = units[index]
        }
        return (Math.round(scaled * 10) / 10) + ' ' + unit
      }

      /** The inbox listing URL, scoped to one session when the slot supplied one. */
      function inboxUrl(sessionId) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return INBOX_PATH
        return INBOX_PATH + '?session=' + encodeURIComponent(sessionId)
      }

      /** Read a response as `{ status, ok, payload }`; a non-JSON body becomes a null payload. */
      function readJson(response) {
        return response.json().then(
          function (payload) { return { status: response.status, ok: response.ok, payload: payload } },
          function () { return { status: response.status, ok: response.ok, payload: null } },
        )
      }

      /** POST JSON and read the reply; a synchronous throw becomes a rejected promise. */
      function postJson(path, body) {
        var request = null
        try {
          request = fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch (error) {
          return Promise.reject(error)
        }
        return request.then(readJson)
      }

      /**
       * The failure text of an error payload, honouring the frozen
       * `{ ok: false, error, hint? }` shape; the hint is surfaced verbatim.
       */
      function errorText(payload, fallback) {
        if (payload && typeof payload === 'object') {
          var error = typeof payload.error === 'string' ? payload.error : ''
          var hint = typeof payload.hint === 'string' ? payload.hint : ''
          if (error && hint) return error + ' — ' + hint
          if (error) return error
          if (hint) return hint
        }
        return fallback
      }

      /**
       * One File as bare base64 (the `data:<mime>;base64,` prefix stripped once).
       * @param file - the selected file.
       * @returns a promise of the payload the upload route expects.
       */
      function fileToBase64(file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader()
          reader.onerror = function () { reject(new Error(STRINGS.readFailed + ' ' + file.name)) }
          reader.onload = function () {
            var result = typeof reader.result === 'string' ? reader.result : ''
            var base64 = result.replace(/^data:[^;]+;base64,/, '')
            if (base64.length === 0 || base64 === result) {
              reject(new Error(STRINGS.readFailed + ' ' + file.name))
              return
            }
            resolve(base64)
          }
          reader.readAsDataURL(file)
        })
      }

      /** Copy text to the clipboard, falling back to a hidden selection for older shells. */
      function copyText(text) {
        if (typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text)
        }
        return new Promise(function (resolve, reject) {
          try {
            var area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            var copied = document.execCommand && document.execCommand('copy')
            document.body.removeChild(area)
            if (copied) resolve()
            else reject(new Error(STRINGS.copyFailed))
          } catch (error) {
            reject(error)
          }
        })
      }

      /**
       * Fixed-position placement above the anchor, clamped inside the viewport.
       *
       * Mirrors the harness's own trigger-anchored dialog seat (`useAnchoredPosition`,
       * consumed by ui-chat's stat dialog) with one addition: the ROW is observed
       * too. This dock row can change size without a window resize or a scroll —
       * a sibling pill reflowing, or this plugin's own count text widening — and
       * an anchor-only watch would leave the panel behind.
       */
      function usePanelPosition(open, anchorRef, panelRef, rowRef) {
        var state = React.useState(null)
        var position = state[0]
        var setPosition = state[1]
        React.useLayoutEffect(function () {
          if (!open) {
            setPosition(null)
            return undefined
          }
          var place = function () {
            var anchor = anchorRef.current
            var panel = panelRef.current
            if (!anchor || !panel || typeof anchor.getBoundingClientRect !== 'function') return
            var rect = anchor.getBoundingClientRect()
            var width = panel.offsetWidth || 0
            var height = panel.offsetHeight || 0
            // Right-aligned on the pill (it sits at the composer's right edge),
            // then clamped so a narrow window cannot push the panel off-screen.
            var left = rect.right - width
            var top = rect.top - PANEL_GAP - height
            if (width > 0) left = Math.min(Math.max(left, PANEL_MARGIN), window.innerWidth - width - PANEL_MARGIN)
            if (height > 0) top = Math.min(Math.max(top, PANEL_MARGIN), window.innerHeight - height - PANEL_MARGIN)
            setPosition({ left: left, top: top })
          }
          place()
          // Capture phase: nested scrollers (the transcript) count too.
          window.addEventListener('scroll', place, true)
          window.addEventListener('resize', place)
          var observers = []
          if (typeof ResizeObserver !== 'undefined') {
            var watch = function (element) {
              if (!element) return
              var observer = new ResizeObserver(place)
              observer.observe(element)
              observers.push(observer)
            }
            watch(anchorRef.current)
            watch(panelRef.current)
            watch(rowRef.current)
          }
          return function () {
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
            for (var index = 0; index < observers.length; index += 1) observers[index].disconnect()
          }
        }, [open, anchorRef, panelRef, rowRef])
        return position
      }

      /**
       * Popover dismissal: the pill's own click toggles the panel, a pointerdown
       * or click outside closes it, Escape closes it and hands focus back to the
       * pill. The click listener is a capture listener because keyboard
       * activation of a sibling control fires click without pointerdown; the
       * opening click cannot self-close because these listeners attach only
       * after it completed.
       */
      function useDismiss(open, setOpen, anchorRef, panelRef, triggerRef) {
        React.useEffect(function () {
          if (!open) return undefined
          var inside = function (target) {
            if (!(target instanceof Node)) return false
            var anchor = anchorRef.current
            var panel = panelRef.current
            return (anchor && anchor.contains(target)) === true
              || (panel && panel.contains(target)) === true
          }
          var closeOutside = function (event) {
            if (!inside(event.target)) setOpen(false)
          }
          var onKeyDown = function (event) {
            if (event.key !== 'Escape') return
            setOpen(false)
            var trigger = triggerRef.current
            if (trigger && typeof trigger.focus === 'function') {
              try { trigger.focus({ preventScroll: true }) } catch (error) { /* focus is a nicety */ }
            }
          }
          document.addEventListener('pointerdown', closeOutside)
          document.addEventListener('click', closeOutside, true)
          document.addEventListener('keydown', onKeyDown)
          return function () {
            document.removeEventListener('pointerdown', closeOutside)
            document.removeEventListener('click', closeOutside, true)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open, setOpen, anchorRef, panelRef, triggerRef])
      }

      /**
       * The session-scoped inbox listing: one fetch per session/reload token,
       * keeping the last good payload on screen when a later fetch fails.
       * @returns `[snapshot, reload]`; `snapshot` is `{ status, data, error }`.
       */
      function useInbox(sessionId) {
        var tokenState = React.useState(0)
        var token = tokenState[0]
        var setToken = tokenState[1]
        var snapshotState = React.useState({ status: 'loading', data: null, error: '' })
        var snapshot = snapshotState[0]
        var setSnapshot = snapshotState[1]
        React.useEffect(function () {
          var alive = true
          setSnapshot(function (previous) {
            return previous.data
              ? { status: 'ready', data: previous.data, error: '' }
              : { status: 'loading', data: null, error: '' }
          })
          var request = null
          try {
            request = fetch(inboxUrl(sessionId), { cache: 'no-store', headers: { accept: 'application/json' } })
          } catch (error) {
            request = null
          }
          if (!request) {
            setSnapshot({ status: 'error', data: null, error: STRINGS.loadFailed })
            return undefined
          }
          request.then(readJson).then(function (result) {
            if (!alive) return
            if (result.ok && result.payload && typeof result.payload === 'object') {
              setSnapshot({ status: 'ready', data: result.payload, error: '' })
            } else {
              setSnapshot(function (previous) {
                return {
                  status: 'error',
                  data: previous.data,
                  error: errorText(result.payload, 'HTTP ' + result.status),
                }
              })
            }
          }).catch(function (error) {
            if (!alive) return
            setSnapshot(function (previous) {
              return { status: 'error', data: previous.data, error: String((error && error.message) || error) }
            })
          })
          return function () { alive = false }
        }, [sessionId, token])
        var reload = React.useCallback(function () { setToken(function (value) { return value + 1 }) }, [])
        return [snapshot, reload]
      }

      /**
       * The panel body: status, upload, and the inbox listing, with loading,
       * empty, and error states. It is a view/upload surface only — the route,
       * tasks, inbox and cache inputs live in the native settings form.
       */
      function Panel(props) {
        var t = props.strings
        var sessionId = props.sessionId
        var snapshot = props.snapshot
        var data = snapshot && snapshot.data ? snapshot.data : null

        var noticeState = React.useState(null)
        var notice = noticeState[0]
        var setNotice = noticeState[1]
        var zoneState = React.useState('reference')
        var zone = zoneState[0]
        var setZone = zoneState[1]
        var filesState = React.useState([])
        var files = filesState[0]
        var setFiles = filesState[1]
        var inputKeyState = React.useState(0)
        var inputKey = inputKeyState[0]
        var setInputKey = inputKeyState[1]
        var uploadingState = React.useState(false)
        var uploading = uploadingState[0]
        var setUploading = uploadingState[1]
        var resultsState = React.useState([])
        var results = resultsState[0]
        var setResults = resultsState[1]
        var copiedState = React.useState('')
        var copiedPath = copiedState[0]
        var setCopiedPath = copiedState[1]
        var copyTimer = React.useRef(null)

        // Focus the surface on open so the keyboard reaches its fields and so
        // Escape and wheel-scrolling behave before the first Tab. Non-modal on
        // purpose: no focus trap, the transcript underneath stays usable.
        React.useEffect(function () {
          var panel = props.panelRef && props.panelRef.current
          if (!panel || typeof panel.focus !== 'function') return undefined
          try { panel.focus({ preventScroll: true }) } catch (error) { /* focus is a nicety */ }
          return undefined
        }, [])

        // The "copied" reset is a component resource: it must not fire after the
        // dock entry unmounts.
        React.useEffect(function () {
          return function () {
            if (copyTimer.current) clearTimeout(copyTimer.current)
          }
        }, [])

        var copy = function (image) {
          copyText(image.path).then(function () {
            setNotice(null)
            setCopiedPath(image.path)
            if (copyTimer.current) clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(function () { setCopiedPath('') }, COPY_RESET_MS)
          }, function () {
            setNotice({ kind: 'bad', lead: image.name, text: t.copyFailed })
          })
        }

        var remove = function (image) {
          setNotice(null)
          postJson(REMOVE_PATH, { session: sessionId, path: image.path }).then(function (result) {
            var payload = result.payload
            var hint = payload && typeof payload.hint === 'string' && payload.hint.length > 0 ? payload.hint : ''
            setNotice({
              kind: 'note',
              lead: image.name,
              text: hint || errorText(payload, 'HTTP ' + result.status),
            })
          }, function (error) {
            setNotice({ kind: 'bad', lead: image.name, text: String((error && error.message) || error) })
          })
        }

        var runUpload = function () {
          var list = files.slice()
          if (list.length === 0) {
            setNotice({ kind: 'bad', lead: '', text: t.noFiles })
            return
          }
          setNotice(null)
          setResults([])
          setUploading(true)
          // Sequential on purpose: one route call at a time keeps the host's
          // size and store checks readable, and the results list ordered.
          var step = function (index, collected) {
            if (index >= list.length) return Promise.resolve(collected)
            var file = list[index]
            var key = index + ':' + file.name
            return fileToBase64(file).then(function (base64) {
              return postJson(UPLOAD_PATH, { session: sessionId, zone: zone, name: file.name, data: base64 })
            }).then(function (result) {
              if (result.ok && result.payload && result.payload.ok === true) {
                var bytes = typeof result.payload.bytes === 'number' ? formatBytes(result.payload.bytes) : ''
                collected.push({ key: key, name: file.name, ok: true, text: t.uploaded + (bytes ? ' · ' + bytes : '') })
              } else {
                collected.push({
                  key: key,
                  name: file.name,
                  ok: false,
                  text: errorText(result.payload, 'HTTP ' + result.status),
                })
              }
            }, function (error) {
              collected.push({ key: key, name: file.name, ok: false, text: String((error && error.message) || error) })
            }).then(function () {
              setResults(collected.slice())
              return step(index + 1, collected)
            })
          }
          step(0, []).then(function () {
            setUploading(false)
            setFiles([])
            setInputKey(function (value) { return value + 1 })
            props.reload()
          })
        }

        var images = data && Array.isArray(data.images) ? data.images : []
        var zones = data && data.zones && typeof data.zones === 'object' ? data.zones : {}
        var groups = ZONES.map(function (entry) {
          return {
            id: entry.id,
            label: entry.label,
            dir: typeof zones[entry.id] === 'string' ? zones[entry.id] : '',
            items: images.filter(function (image) { return image && image.zone === entry.id }),
          }
        })
        var total = images.length
        var deleteHint = data && typeof data.deleteHint === 'string' && data.deleteHint.length > 0 ? data.deleteHint : ''

        var statusRows = []
        if (data) {
          statusRows.push({ key: 'inbox', label: t.labelInbox, value: data.inbox || t.unset, path: true })
          statusRows.push({ key: 'project', label: t.labelProjectDir, value: data.projectDir || t.unset, path: true })
          statusRows.push({ key: 'route', label: t.labelRoute, value: data.route || t.routeUnset, path: false })
          statusRows.push({
            key: 'routeState',
            label: t.labelRouteState,
            value: (data.routeReady === true ? t.routeReady : t.routeNotReady)
              + (typeof data.routeDetail === 'string' && data.routeDetail.length > 0 ? ' · ' + data.routeDetail : ''),
            path: false,
          })
          statusRows.push({ key: 'agents', label: t.labelAgents, value: data.agents || t.unset, path: false })
          if (Array.isArray(data.tasks) && data.tasks.length > 0) {
            statusRows.push({ key: 'tasks', label: t.labelTasks, value: data.tasks.join(', '), path: false })
          }
        }

        var statusSection = data ? h('section', { className: 'dshvb-section', 'aria-label': t.statusHeading },
          h('h5', null, t.statusHeading),
          h('dl', { className: 'dshvb-kv' }, statusRows.map(function (row) {
            return h(React.Fragment, { key: row.key },
              h('dt', null, row.label),
              h('dd', null, row.path ? h('code', { className: 'dshvb-path' }, row.value) : row.value),
            )
          })),
          data.canDelete === true ? null : h('p', { id: 'dshvb-delete-hint', className: 'dshvb-note' },
            t.cannotDelete + ' ' + (deleteHint || t.cannotDeleteShort)),
        ) : null

        var uploadsSupported = data ? data.uploadsSupported !== false : false
        var zoneChoices = ZONES.map(function (entry) {
          return h('label', { key: entry.id, className: 'dshvb-choice', htmlFor: 'dshvb-zone-' + entry.id },
            h('input', {
              id: 'dshvb-zone-' + entry.id,
              type: 'radio',
              name: 'dshvb-zone',
              value: entry.id,
              checked: zone === entry.id,
              onChange: function () { setZone(entry.id) },
            }),
            h('span', null, entry.label),
          )
        })

        var uploadSection = h('section', { className: 'dshvb-section', 'aria-label': t.uploadHeading },
          h('h5', null, t.uploadHeading),
          h('fieldset', { className: 'dshvb-zone' },
            h('legend', null, t.zoneLegend),
            zoneChoices,
          ),
          h('div', { className: 'dshvb-actions' },
            h('label', { className: 'dshvb-choice', htmlFor: 'dshvb-files' }, t.chooseFiles),
            h('input', {
              key: 'dshvb-files-' + inputKey,
              id: 'dshvb-files',
              className: 'dshvb-file',
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif',
              multiple: true,
              onChange: function (event) {
                var selected = event && event.target && event.target.files
                  ? Array.prototype.slice.call(event.target.files)
                  : []
                setFiles(selected)
                setResults([])
                setNotice(null)
              },
            }),
          ),
          h('div', { className: 'dshvb-actions' },
            h('button', {
              type: 'button',
              className: 'dshvb-button',
              disabled: uploading || !uploadsSupported || files.length === 0,
              onClick: runUpload,
            }, uploading ? t.uploading : t.upload),
          ),
          uploadsSupported ? null : h('p', { className: 'dshvb-note' }, t.uploadsUnsupported),
          uploadsSupported && files.length === 0 && !uploading ? h('p', { className: 'dshvb-note' }, t.noFiles) : null,
          results.length > 0 ? h('ul', { className: 'dshvb-results', role: 'status', 'aria-live': 'polite' },
            results.map(function (entry) {
              return h('li', { key: entry.key, className: entry.ok ? 'dshvb-ok' : 'dshvb-bad' },
                entry.name + ' — ' + entry.text)
            })) : null,
        )

        var renderImage = function (image) {
          var copied = copiedPath === image.path
          return h('li', { key: image.zone + '/' + image.path, className: 'dshvb-item' },
            h('div', { className: 'dshvb-item-head' },
              h('span', { className: 'dshvb-name', title: image.name }, image.name),
              h('span', { className: 'dshvb-badge' }, image.source === 'upload' ? t.sourceUpload : t.sourceFolder),
              h('span', { className: 'dshvb-note' }, formatBytes(image.bytes)),
            ),
            // Selectable path text as well as the Copy path button: the agent
            // needs the exact path, and a failed clipboard still leaves it there.
            h('code', { className: 'dshvb-path' }, image.path),
            h('div', { className: 'dshvb-actions' },
              h('button', {
                type: 'button',
                className: 'dshvb-button',
                'aria-label': t.copyPath + ' ' + image.name,
                onClick: function () { copy(image) },
              }, copied ? t.copied : t.copyPath),
              h('button', {
                type: 'button',
                className: 'dshvb-button',
                'aria-label': t.removeAria + ' ' + image.name,
                'aria-describedby': 'dshvb-delete-hint',
                onClick: function () { remove(image) },
              }, t.remove),
            ),
          )
        }

        var imageSection = h('section', { className: 'dshvb-section', 'aria-label': t.imagesHeading },
          h('h5', null, t.imagesHeading),
          !data ? null : (total === 0
            ? h('p', { className: 'dshvb-note' }, t.empty)
            : h('div', { className: 'dshvb-groups' }, groups.map(function (group) {
              return h('div', { key: group.id, className: 'dshvb-group' },
                h('div', { className: 'dshvb-zone-head' },
                  h('span', null, group.label),
                  h('span', { className: 'dshvb-note' }, String(group.items.length)),
                ),
                group.dir ? h('code', { className: 'dshvb-path' }, group.dir) : null,
                group.items.length === 0
                  ? h('p', { className: 'dshvb-note' }, t.zoneEmpty)
                  : h('ul', { className: 'dshvb-list' }, group.items.map(renderImage)),
              )
            }))),
        )

        var body = null
        if (!data && snapshot.status === 'loading') {
          body = h('p', { className: 'dshvb-note', role: 'status', 'aria-live': 'polite' }, t.loading)
        } else if (!data) {
          body = h('div', { className: 'dshvb-section', role: 'alert' },
            h('p', { className: 'dshvb-note dshvb-bad' }, snapshot.error || t.loadFailed),
            h('div', { className: 'dshvb-actions' },
              h('button', { type: 'button', className: 'dshvb-button', onClick: props.reload }, t.retry),
            ),
          )
        } else {
          body = h(React.Fragment, null,
            snapshot.status === 'error'
              ? h('div', { className: 'dshvb-section', role: 'alert' },
                h('p', { className: 'dshvb-note dshvb-bad' }, snapshot.error || t.loadFailed),
                h('div', { className: 'dshvb-actions' },
                  h('button', { type: 'button', className: 'dshvb-button', onClick: props.reload }, t.retry),
                ),
              )
              : null,
            statusSection,
            uploadSection,
            imageSection,
            notice
              ? h('div', { className: 'dshvb-note', role: 'status', 'aria-live': 'polite' },
                notice.lead ? h('div', null, notice.lead) : null,
                h('div', { className: notice.kind === 'bad' ? 'dshvb-bad' : 'dshvb-note' }, notice.text),
              )
              : null,
          )
        }

        return h('div', {
          ref: props.panelRef,
          className: 'dshvb-panel',
          role: 'dialog',
          'aria-label': t.title,
          tabIndex: -1,
          style: props.pos
            ? { left: props.pos.left + 'px', top: props.pos.top + 'px' }
            : MEASURE_STYLE,
        },
          h('div', { className: 'dshvb-head' },
            h('h4', { className: 'dshvb-title' }, t.title),
            h('button', {
              type: 'button',
              className: 'dshvb-button',
              'aria-label': t.close,
              onClick: props.onClose,
            }, t.close),
          ),
          body,
          h('p', { className: 'dshvb-footer' }, t.footer),
        )
      }

      /** The composer-dock entry: an in-flow pill plus the portaled panel. */
      function VisionDock(props) {
        var t = STRINGS
        var sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined
        var inbox = useInbox(sessionId)
        var snapshot = inbox[0]
        var reload = inbox[1]
        var openState = React.useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var anchorRef = React.useRef(null)
        var pillRef = React.useRef(null)
        var panelRef = React.useRef(null)
        var rowRef = React.useRef(null)
        // Placement and dismissal mirror the harness's own trigger-anchored
        // dialog; the row ref is ours because this entry's own size can change
        // without a window resize or a scroll.
        var position = usePanelPosition(open, anchorRef, panelRef, rowRef)
        useDismiss(open, setOpen, anchorRef, panelRef, pillRef)

        // A fresh listing whenever the panel opens: the agent may have written
        // to the inbox folder since the count was fetched.
        React.useEffect(function () {
          if (open) reload()
        }, [open])

        var images = snapshot.data && Array.isArray(snapshot.data.images) ? snapshot.data.images : null
        var count = images ? images.length : null
        var pillText = count === null ? t.pill : t.pillCount + ' ' + count
        var pillAria = count === null ? t.pill : t.pill + ', ' + count + ' ' + t.imagesWord

        var pill = h('span', { className: 'dshvb-anchor', ref: anchorRef },
          h('button', {
            type: 'button',
            ref: pillRef,
            className: 'dshvb-pill',
            onClick: function () { setOpen(!open) },
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': pillAria,
            title: t.pill,
          },
            h('span', { className: 'dshvb-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'dshvb-label' }, pillText),
          ),
        )

        var row = h('div', { ref: rowRef, className: 'dshvb-row' }, pill)
        // The stylesheet rides the component as an element, so the dock entry
        // unmounting removes it; the factory itself stays free of side effects.
        var style = h('style', { key: 'dshvb-style' }, CSS)
        if (!open) return h(React.Fragment, null, style, row)

        // Portaled to <body>. Outside the composer's layout flow (so the bar
        // cannot be pushed), outside its containing blocks and overflow clips
        // (a `position: fixed` element inside a backdrop-filtered ancestor is
        // still trapped by it), and above the app's layers via z-index 1100.
        var panel = h(Panel, {
          strings: t,
          sessionId: sessionId,
          snapshot: snapshot,
          reload: reload,
          pos: position,
          panelRef: panelRef,
          onClose: function () { setOpen(false) },
        })
        return h(React.Fragment, null, style, row, createPortal ? createPortal(panel, document.body) : panel)
      }

      return {
        inject: ['slots'],
        apply: function (ctx) {
          // The registration callback returns the slot registration itself, so
          // the slots service owns its disposal; no other resource is created
          // here and the factory stays side-effect free.
          try {
            ctx.slots.inject('conversation.composer.dock', function () {
              return ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-vision-bridge', order: 55 }, VisionDock)
            })
          } catch (error) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('dsh-vision-bridge: could not register the composer-dock inbox entry', error)
            }
          }
        },
      }
    },
  })
})()
