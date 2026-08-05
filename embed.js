/**
 * FlareHQ Embedded Checkout loader.
 *
 * Merchant integration (minimal):
 *
 *   <div id="flarehq-checkout" data-reference="escrow_or_payment_reference"></div>
 *   <script src="https://flarehq.xyz/embed.js"></script>
 *
 * Optional: react to payment completion in your own page JS:
 *
 *   window.FlareHQ.onEvent(function (event) {
 *     if (event.type === 'payment_success') {
 *       // e.g. redirect, show a thank-you message, close a modal
 *     }
 *   });
 *
 * Multiple checkouts on one page are supported — each target div gets its
 * own iframe, resized independently.
 */
(function () {
  var FLAREHQ_ORIGIN = 'https://flarehq.xyz';
  var listeners = [];

  function createIframe(container, reference) {
    var iframe = document.createElement('iframe');
    iframe.src = FLAREHQ_ORIGIN + '/checkout/embed/' + encodeURIComponent(reference);
    iframe.style.width = '100%';
    iframe.style.border = 'none';
    iframe.style.minHeight = '400px'; // sensible default until the first resize event arrives
    iframe.setAttribute('title', 'FlareHQ Checkout');
    iframe.setAttribute('data-flarehq-reference', reference);
    container.appendChild(iframe);
    return iframe;
  }

  function init() {
    var containers = document.querySelectorAll('[data-reference][id^="flarehq-checkout"], #flarehq-checkout[data-reference]');
    // Fallback for the simple single-checkout case described in the docstring above.
    if (containers.length === 0) {
      var single = document.getElementById('flarehq-checkout');
      if (single && single.getAttribute('data-reference')) {
        containers = [single];
      }
    }

    containers.forEach(function (container) {
      var reference = container.getAttribute('data-reference');
      if (!reference) return;
      createIframe(container, reference);
    });
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'flarehq-checkout') return;

    // Auto-resize the matching iframe.
    if (e.data.event === 'resize' && typeof e.data.height === 'number') {
      var iframes = document.querySelectorAll('iframe[data-flarehq-reference="' + e.data.reference + '"]');
      iframes.forEach(function (f) {
        f.style.height = e.data.height + 'px';
      });
      return;
    }

    // Relay every other event to any merchant-registered listeners.
    listeners.forEach(function (cb) {
      try {
        cb(Object.assign({ reference: e.data.reference }, e.data.payload));
      } catch (err) {
        console.error('[FlareHQ embed] listener error:', err);
      }
    });
  });

  window.FlareHQ = window.FlareHQ || {};
  window.FlareHQ.onEvent = function (callback) {
    if (typeof callback === 'function') listeners.push(callback);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
