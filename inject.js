(function () {
  var active = true;
  var coherence = new WeakMap();
  var dummyAudio = new Audio();
  var ogDesc = {
    playbackRate: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate'),
    defaultPlaybackRate: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'defaultPlaybackRate')
  };
  var trackedElements = [];

  function hijackProperty(propName) {
    var desc = ogDesc[propName];
    var map = new Map();
    Object.defineProperty(HTMLMediaElement.prototype, propName, {
      configurable: true,
      enumerable: true,
      get: function () {
        desc.get.call(this);
        if (active && map.has(this)) {
          return map.get(this);
        }
        return desc.get.call(this);
      },
      set: function (val) {
        if (!active) {
          desc.set.call(this, val);
          map.set(this, val);
          return;
        }
        try {
          desc.set.call(dummyAudio, val);
          var validated = desc.get.call(dummyAudio);
          map.set(this, validated);
        } catch (e) {}
      }
    });
    coherence[propName] = map;
  }

  hijackProperty('playbackRate');
  hijackProperty('defaultPlaybackRate');

  function trackElement(el) {
    if (trackedElements.indexOf(el) === -1) {
      trackedElements.push(el);
      if (active) {
        coherence.playbackRate.set(el, ogDesc.playbackRate.get.call(el));
        coherence.defaultPlaybackRate.set(el, ogDesc.defaultPlaybackRate.get.call(el));
      }
    }
  }

  var origPlay = HTMLMediaElement.prototype.play;
  var origLoad = HTMLMediaElement.prototype.load;
  var origPause = HTMLMediaElement.prototype.pause;

  HTMLMediaElement.prototype.play = function () {
    trackElement(this);
    return origPlay.apply(this, arguments);
  };
  HTMLMediaElement.prototype.play.toString = function () { return origPlay.toString(); };

  HTMLMediaElement.prototype.pause = function () {
    trackElement(this);
    return origPause.apply(this, arguments);
  };
  HTMLMediaElement.prototype.pause.toString = function () { return origPause.toString(); };

  HTMLMediaElement.prototype.load = function () {
    trackElement(this);
    return origLoad.apply(this, arguments);
  };
  HTMLMediaElement.prototype.load.toString = function () { return origLoad.toString(); };

  new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      m.addedNodes.forEach(function (node) {
        if (node instanceof HTMLMediaElement) {
          trackElement(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('video, audio').forEach(trackElement);
        }
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  document.querySelectorAll('video, audio').forEach(trackElement);

  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'CX_SET_SPEED') {
      var speed = e.data.speed;
      trackedElements.forEach(function (el) {
        ogDesc.playbackRate.set.call(el, speed);
        ogDesc.defaultPlaybackRate.set.call(el, speed);
      });
    }
  });
})();
