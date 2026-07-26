/*
 * Loading-screen progress wire.
 *
 * FXServer pushes loadscreen telemetry into the CEF page via
 * window.postMessage. The payload lands on `event.data` and carries an
 * `eventName` discriminator plus event-specific fields:
 *
 *   loadProgress             { loadFraction }
 *   startInitFunction        { type, count }
 *   endInitFunction          { type }
 *   startInit                { name }
 *   endInit                  { name }
 *   startDataFileEntries     { count }
 *   endDataFileEntries
 *   performMapLoadFunction   { numCalls }
 *   onLogLine                { message }
 *
 * Note: previous iterations of the script used
 * `window.addEventListener('loadProgress', ...)` because the FiveM docs
 * historically described it that way. In practice the client dispatches
 * via postMessage so the named-event listener never fired, the bar
 * stayed at 0%, and FXServer's bottom-right fallback overlay kept
 * painting actual progress. Switching to the unified `message` listener
 * fixes both: our bar tracks the real fraction, and the fallback hides
 * because the page is now reporting status itself.
 */
(function () {
  'use strict';

  var Fill = document.getElementById('ProgressFill');
  var Percent = document.getElementById('ProgressPercent');
  var Label = document.getElementById('ProgressLabel');

  var Fraction = 0;

  /**
   * Paint the current fraction as a width and a percentage.
   *
   * Clamps to 0-100 because the engine's fraction is not guaranteed to
   * stay in range - an out-of-band value would otherwise push the fill
   * bar outside its track.
   */
  function Render() {
    var Pct = Math.max(0, Math.min(100, Math.round(Fraction * 100)));
    if (Fill !== null) Fill.style.width = Pct + '%';
    if (Percent !== null) Percent.textContent = Pct + '%';
  }

  /**
   * Update the status line, ignoring empty or non-string values so a
   * malformed payload leaves the previous label rather than blanking it.
   */
  function SetLabel(Text) {
    if (Label !== null && typeof Text === 'string' && Text.length > 0) {
      Label.textContent = Text;
    }
  }

  /**
   * Turn an engine type name into readable prose, or null if unusable.
   * See the inline note for the shape these arrive in.
   */
  function FormatType(Raw) {
    if (typeof Raw !== 'string' || Raw.length === 0) return null;
    // Engine type names arrive shouty + underscored ("BEFORE_MAP_LOADED");
    // collapse to "Before map loaded" for the label.
    var Pretty = Raw.toLowerCase().replace(/_/g, ' ');
    return Pretty.charAt(0).toUpperCase() + Pretty.slice(1);
  }

  /**
   * Route one telemetry payload by its `eventName` discriminator.
   *
   * The shared sink for both delivery paths below, which is why it takes
   * a plain object rather than an Event. Unknown names fall through
   * silently - the engine emits more events than this page cares about,
   * and the list varies by build.
   */
  function HandleEvent(Data) {
    if (Data === null || typeof Data !== 'object') return;
    switch (Data.eventName) {
      case 'loadProgress': {
        var Value = Data.loadFraction;
        if (typeof Value === 'number' && isFinite(Value)) {
          Fraction = Value;
          Render();
        }
        return;
      }
      case 'startInitFunction': {
        var Pretty = FormatType(Data.type);
        if (Pretty !== null) SetLabel('Initialising ' + Pretty);
        return;
      }
      case 'startInit': {
        if (typeof Data.name === 'string' && Data.name.length > 0) {
          SetLabel('Loading ' + Data.name);
        }
        return;
      }
      case 'performMapLoadFunction': {
        SetLabel('Loading map');
        return;
      }
      case 'startDataFileEntries': {
        SetLabel('Streaming game data');
        return;
      }
      default:
        return;
    }
  }

  // Primary path: FXServer's postMessage stream.
  window.addEventListener('message', function (Event) {
    HandleEvent(Event && Event.data);
  });

  // Legacy / forked builds that still dispatch named CustomEvents.
  // Harmless overlap with the message listener; whichever fires updates
  // the same render state.
  /**
   * Bridge a named CustomEvent into HandleEvent, normalising the payload
   * out of either `.data` or `.detail` and re-attaching the event name
   * that the message path carries inline.
   */
  function ForwardNamedEvent(Name) {
    window.addEventListener(Name, function (Event) {
      var Data = Event && (Event.data || Event.detail);
      if (Data !== null && typeof Data === 'object') {
        HandleEvent(Object.assign({ eventName: Name }, Data));
      } else {
        HandleEvent({ eventName: Name });
      }
    });
  }
  ForwardNamedEvent('loadProgress');
  ForwardNamedEvent('startInitFunction');
  ForwardNamedEvent('startInit');
  ForwardNamedEvent('performMapLoadFunction');
  ForwardNamedEvent('startDataFileEntries');

  // Paint the zero-state immediately so the bar is visible before the
  // first tick lands.
  Render();
})();
