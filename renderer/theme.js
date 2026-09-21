/*
 * TO-DO Panel 照片主题调色板（渲染层、自包含）
 *
 * - 纯浏览器端脚本：无构建步骤、无依赖、不 require、不访问文件系统、不发网络请求。
 * - 只做两件有副作用的事：apply() 写 CSS 变量与 data-theme，clear() 还原。
 * - 其余函数（生成 / 校验 / 对比度计算）都是纯函数，便于单测。
 *
 * 语义调色板固定 19 个键：
 *   bg surface1 surface2 surface3 hairline hairlineSoft highlightTop squircleHighlight
 *   text1 text2 text3 text4 accent scrollThumb scrollThumbHover tooltipBg itemHover panelShadow
 * CLASSIC_PALETTE 的每个值都与 renderer/styles.css :root 的原值逐字节一致，
 * 因此经典黑主题下 apply(CLASSIC_PALETTE, 'app') 是零视觉改动。
 */
(function (global) {
  'use strict';

  var PALETTE_KEYS = [
    'bg',
    'surface1',
    'surface2',
    'surface3',
    'hairline',
    'hairlineSoft',
    'highlightTop',
    'squircleHighlight',
    'text1',
    'text2',
    'text3',
    'text4',
    'accent',
    'scrollThumb',
    'scrollThumbHover',
    'tooltipBg',
    'itemHover',
    'panelShadow'
  ];

  var MODE_DARK = 'dark';
  var MODE_LIGHT = 'light';

  var SURFACES = { app: true, notification: true, pet: true };

  var IMAGE_TIMEOUT_MS = 3000;
  var SAMPLE_MAX_EDGE = 64;
  var CLUSTER_COUNT = 6;
  var KMEANS_ITERATIONS = 12;
  var MIN_ALPHA = 0.35;
  var MODE_LUMINANCE_THRESHOLD = 0.45;
  var MIN_ACCENT_SATURATION = 0.25;
  var MAX_CONTRAST_ROUNDS = 24;
  var TARGET_TEXT_STRONG = 4.5;
  var TARGET_TEXT_MUTED = 3.0;

  // 注意：styles.css 里有两个 :root 块，靠后的「Mac Bento · premium surface system」
  // 会再覆盖 --bg-base / --surface-* / --text-* / --panel-shadow，那才是屏幕上
  // 真正生效的经典黑取值。这里保留第一段的基础取值，仅作为色板形状与兜底参考；
  // 经典黑的实际还原走 clear()（移除内联变量，交回样式表级联），不依赖本常量，
  // 设置页的经典黑色板也直接读实时 CSS 变量。
  var CLASSIC_PALETTE = {
    bg: '#000000',
    surface1: '#111111',
    surface2: '#191919',
    surface3: '#252525',
    hairline: 'rgba(255, 255, 255, 0.08)',
    hairlineSoft: 'rgba(255, 255, 255, 0.06)',
    highlightTop: 'rgba(255, 255, 255, 0.07)',
    squircleHighlight: 'rgba(255, 255, 255, 0.16)',
    text1: '#F5F5F5',
    text2: '#A1A1A1',
    text3: '#707070',
    text4: '#4A4A4A',
    accent: '#6EA8FF',
    scrollThumb: 'rgba(255, 255, 255, 0.08)',
    scrollThumbHover: 'rgba(255, 255, 255, 0.20)',
    tooltipBg: 'rgba(0, 0, 0, 0.92)',
    itemHover: 'rgba(255, 255, 255, 0.04)',
    panelShadow: 'rgba(0, 0, 0, 0.42)'
  };

  var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var RGB_RE = /^rgba?\([\d.,\s%]+\)$/;

  /* ---------------------------------------------------------------- 数学工具 */

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function toHex2(value) {
    var text = Math.round(clamp(value, 0, 255)).toString(16);
    return text.length === 1 ? '0' + text : text;
  }

  /* -------------------------------------------------------------- 颜色转换 */

  function parseColor(value) {
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (HEX_RE.test(text)) {
      var body = text.slice(1);
      if (body.length === 3) {
        return {
          r: parseInt(body.charAt(0) + body.charAt(0), 16),
          g: parseInt(body.charAt(1) + body.charAt(1), 16),
          b: parseInt(body.charAt(2) + body.charAt(2), 16)
        };
      }
      return {
        r: parseInt(body.slice(0, 2), 16),
        g: parseInt(body.slice(2, 4), 16),
        b: parseInt(body.slice(4, 6), 16)
      };
    }
    if (RGB_RE.test(text)) {
      var parts = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')).split(',');
      if (parts.length < 3) return null;
      var channels = [];
      for (var i = 0; i < 3; i += 1) {
        var raw = parts[i].trim();
        var number = raw.indexOf('%') >= 0 ? parseFloat(raw) * 2.55 : parseFloat(raw);
        if (isNaN(number)) return null;
        channels.push(Math.round(clamp(number, 0, 255)));
      }
      return { r: channels[0], g: channels[1], b: channels[2] };
    }
    return null;
  }

  function hexToRgb(value) {
    return parseColor(value);
  }

  function rgbToHex(rgb) {
    return (
      '#' + toHex2(rgb.r) + toHex2(rgb.g) + toHex2(rgb.b)
    ).toUpperCase();
  }

  function rgbToHsl(rgb) {
    var r = clamp(rgb.r, 0, 255) / 255;
    var g = clamp(rgb.g, 0, 255) / 255;
    var b = clamp(rgb.b, 0, 255) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var lightness = (max + min) / 2;
    var hue = 0;
    var saturation = 0;
    if (max !== min) {
      var delta = max - min;
      saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
      if (max === r) {
        hue = (g - b) / delta + (g < b ? 6 : 0);
      } else if (max === g) {
        hue = (b - r) / delta + 2;
      } else {
        hue = (r - g) / delta + 4;
      }
      hue = hue / 6;
    }
    return { h: hue, s: saturation, l: lightness };
  }

  function hueToChannel(p, q, t) {
    var value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  }

  function hslToRgb(hsl) {
    var h = hsl.h;
    if (h < 0) h = h - Math.floor(h);
    if (h >= 1) h = h - Math.floor(h);
    var s = clamp(hsl.s, 0, 1);
    var l = clamp(hsl.l, 0, 1);
    var r;
    var g;
    var b;
    if (s === 0) {
      r = l;
      g = l;
      b = l;
    } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hueToChannel(p, q, h + 1 / 3);
      g = hueToChannel(p, q, h);
      b = hueToChannel(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
  }

  function hslToHex(hsl) {
    return rgbToHex(hslToRgb(hsl));
  }

  function relativeLuminance(rgb) {
    if (!rgb) return 0;
    var channels = [rgb.r, rgb.g, rgb.b];
    var weights = [0.2126, 0.7152, 0.0722];
    var total = 0;
    for (var i = 0; i < 3; i += 1) {
      var value = clamp(channels[i], 0, 255) / 255;
      var linear = value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      total += weights[i] * linear;
    }
    return total;
  }

  function contrastRatio(colorA, colorB) {
    var rgbA = parseColor(colorA);
    var rgbB = parseColor(colorB);
    if (!rgbA || !rgbB) return 0;
    var luminanceA = relativeLuminance(rgbA);
    var luminanceB = relativeLuminance(rgbB);
    var lighter = luminanceA > luminanceB ? luminanceA : luminanceB;
    var darker = luminanceA > luminanceB ? luminanceB : luminanceA;
    return (lighter + 0.05) / (darker + 0.05);
  }

  function alphaColor(rgb, alpha) {
    return (
      'rgba(' + Math.round(rgb.r) + ', ' + Math.round(rgb.g) + ', ' + Math.round(rgb.b) + ', ' + alpha + ')'
    );
  }

  function hueColor(hue, surface, text, alpha) {
    var rgb = surface < 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    var tinted = mixHue(rgb, hue, 0.035);
    return alphaColor(tinted, alpha);
  }

  function mixHue(rgb, hue, amount) {
    var target = hslToRgb({ h: hue, s: 1, l: 0.5 });
    var mix = amount;
    return {
      r: rgb.r * (1 - mix) + target.r * mix,
      g: rgb.g * (1 - mix) + target.g * mix,
      b: rgb.b * (1 - mix) + target.b * mix
    };
  }

  /* ---------------------------------------------------------- 对比度反推 */

  var contrastMemo = {};

  function contrastCacheKey(hsl, backgroundHex) {
    return (
      round2(hsl.h * 360) +
      '|' +
      round2(hsl.s * 100) +
      '|' +
      round2(hsl.l * 100) +
      '|' +
      backgroundHex
    );
  }

  function contrastOfHsl(hsl, backgroundHex) {
    var key = contrastCacheKey(hsl, backgroundHex);
    if (!Object.prototype.hasOwnProperty.call(contrastMemo, key)) {
      contrastMemo[key] = contrastRatio(hslToHex(hsl), backgroundHex);
    }
    return contrastMemo[key];
  }

  // 固定色相与饱和度，只改亮度，向高对比方向迭代直到达标（最多 maxRounds 轮）。
  function tuneLightness(hsl, backgroundHex, target, increaseLightness) {
    var ratio = contrastOfHsl(hsl, backgroundHex);
    if (ratio >= target) {
      return { hsl: { h: hsl.h, s: hsl.s, l: hsl.l }, ratio: ratio, rounds: 0 };
    }
    var step = 0.04;
    var current = { h: hsl.h, s: hsl.s, l: hsl.l };
    var rounds = 0;
    var lastGood = null;
    while (rounds < MAX_CONTRAST_ROUNDS) {
      var nextLightness = increaseLightness ? current.l + step : current.l - step;
      if (nextLightness > 1 || nextLightness < 0) break;
      current = { h: hsl.h, s: hsl.s, l: nextLightness };
      rounds += 1;
      ratio = contrastOfHsl(current, backgroundHex);
      if (ratio >= target) {
        lastGood = { h: current.h, s: current.s, l: current.l };
        break;
      }
      step *= 1.25;
      if (step > 0.4) step = 0.4;
    }
    var chosen = lastGood || current;
    return {
      hsl: { h: chosen.h, s: chosen.s, l: chosen.l },
      ratio: contrastOfHsl(chosen, backgroundHex),
      rounds: rounds
    };
  }

  /* ------------------------------------------------------ 采样与色彩量化 */

  function loadImage(dataUrl) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      var image = new global.Image();

      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          global.clearTimeout(timer);
          timer = null;
        }
        image.onload = null;
        image.onerror = null;
        resolve(result);
      }

      image.onload = function () {
        finish(image);
      };
      image.onerror = function () {
        finish(null);
      };
      timer = global.setTimeout(function () {
        finish(null);
      }, IMAGE_TIMEOUT_MS);

      image.decoding = 'sync';
      image.src = dataUrl;
    });
  }

  function drawSampled(image) {
    var width = image.naturalWidth || image.width || 0;
    var height = image.naturalHeight || image.height || 0;
    if (!width || !height) return null;

    var scale = SAMPLE_MAX_EDGE / Math.max(width, height);
    if (scale > 1) scale = 1;
    var sampleWidth = Math.max(1, Math.round(width * scale));
    var sampleHeight = Math.max(1, Math.round(height * scale));

    var canvas = global.document.createElement('canvas');
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    var context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight);

    var pixels;
    try {
      pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
    } catch (error) {
      return null;
    }
    return { data: pixels, width: sampleWidth, height: sampleHeight };
  }

  function collectSamples(sampled) {
    var data = sampled.data;
    var total = sampled.width * sampled.height;
    var samples = [];
    var luminanceSum = 0;
    var count = 0;
    for (var index = 0; index < total; index += 1) {
      var offset = index * 4;
      var alpha = data[offset + 3] / 255;
      if (alpha < MIN_ALPHA) continue;
      var color = { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
      samples.push({ r: color.r, g: color.g, b: color.b, a: alpha });
      luminanceSum += relativeLuminance(color);
      count += 1;
    }
    if (!count) return null;
    return { samples: samples, meanLuminance: luminanceSum / count };
  }

  function distanceSquared(a, b) {
    var dr = a.r - b.r;
    var dg = a.g - b.g;
    var db = a.b - b.b;
    return dr * dr + dg * dg + db * db;
  }

  function seedCenters(samples, count) {
    var centers = [];
    var firstIndex = Math.floor(samples.length / 2);
    centers.push({ r: samples[firstIndex].r, g: samples[firstIndex].g, b: samples[firstIndex].b });
    while (centers.length < count) {
      var bestSample = null;
      var bestScore = -1;
      for (var i = 0; i < samples.length; i += 1) {
        var nearest = Infinity;
        for (var c = 0; c < centers.length; c += 1) {
          var candidate = distanceSquared(samples[i], centers[c]);
          if (candidate < nearest) nearest = candidate;
        }
        if (nearest > bestScore) {
          bestScore = nearest;
          bestSample = samples[i];
        }
      }
      if (!bestSample) break;
      centers.push({ r: bestSample.r, g: bestSample.g, b: bestSample.b });
    }
    return centers;
  }

  // 简易 k-means：最多 6 簇，返回每簇的代表色与占比（按像素数加权）。
  function quantize(samples) {
    var clusterCount = Math.min(CLUSTER_COUNT, samples.length);
    var centers = seedCenters(samples, clusterCount);
    if (!centers.length) return [];
    var assignments = new Array(samples.length);
    var iteration = 0;
    while (iteration < KMEANS_ITERATIONS) {
      var changed = false;
      for (var i = 0; i < samples.length; i += 1) {
        var nearestIndex = 0;
        var nearestDistance = Infinity;
        for (var c = 0; c < centers.length; c += 1) {
          var distance = distanceSquared(samples[i], centers[c]);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = c;
          }
        }
        if (assignments[i] !== nearestIndex) {
          assignments[i] = nearestIndex;
          changed = true;
        }
      }
      var sums = [];
      var counts = [];
      for (var s = 0; s < centers.length; s += 1) {
        sums.push({ r: 0, g: 0, b: 0 });
        counts.push(0);
      }
      for (var p = 0; p < samples.length; p += 1) {
        var slot = assignments[p];
        sums[slot].r += samples[p].r;
        sums[slot].g += samples[p].g;
        sums[slot].b += samples[p].b;
        counts[slot] += 1;
      }
      for (var k = 0; k < centers.length; k += 1) {
        if (!counts[k]) continue;
        centers[k] = {
          r: sums[k].r / counts[k],
          g: sums[k].g / counts[k],
          b: sums[k].b / counts[k]
        };
      }
      iteration += 1;
      if (!changed && iteration > 1) break;
    }

    var clusters = [];
    for (var index = 0; index < centers.length; index += 1) {
      if (!counts[index]) continue;
      var rgb = {
        r: Math.round(centers[index].r),
        g: Math.round(centers[index].g),
        b: Math.round(centers[index].b)
      };
      var hsl = rgbToHsl(rgb);
      clusters.push({
        rgb: rgb,
        hex: rgbToHex(rgb),
        hsl: hsl,
        weight: counts[index] / samples.length,
        weightPx: counts[index],
        luminance: relativeLuminance(rgb)
      });
    }
    clusters.sort(function (a, b) {
      return b.weight - a.weight;
    });
    return clusters;
  }

  // 基调色选择：既要占比高，也要符合目标明暗，避免一张照片里的小面积高饱和色
  // （如夜景中的霓虹红）抢走整块背景的色相。
  function pickBaseCluster(clusters, mode) {
    var index;
    var best = null;
    var bestScore = -1;
    for (index = 0; index < clusters.length; index += 1) {
      var cluster = clusters[index];
      var weight = cluster.weight;
      var score;
      if (mode === MODE_DARK) {
        if (cluster.luminance > 0.85) continue;
        score = weight * (1.15 - cluster.luminance);
      } else {
        if (cluster.luminance < 0.15) continue;
        score = weight * (0.35 + cluster.luminance);
      }
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
    if (best) return best;
    for (index = 0; index < clusters.length; index += 1) {
      if (mode === MODE_DARK ? clusters[index].luminance <= 0.9 : clusters[index].luminance >= 0.3) {
        return clusters[index];
      }
    }
    return clusters[0];
  }

  function pickAccentCluster(clusters) {
    var best = null;
    for (var index = 0; index < clusters.length; index += 1) {
      var cluster = clusters[index];
      if (!best) {
        best = cluster;
        continue;
      }
      if (cluster.hsl.s > best.hsl.s) {
        best = cluster;
      } else if (cluster.hsl.s === best.hsl.s && cluster.weight > best.weight) {
        best = cluster;
      }
    }
    if (!best || best.hsl.s < MIN_ACCENT_SATURATION) return null;
    return best;
  }

  function accentFromCluster(cluster) {
    var lightness = cluster.hsl.l < 0.34 ? 0.62 : cluster.hsl.l > 0.7 ? 0.54 : 0.58;
    return hslToHex({ h: cluster.hsl.h, s: clamp(cluster.hsl.s, 0.35, 0.85), l: lightness });
  }

  /* ------------------------------------------------------------ 调色板生成 */

  function buildPalette(clusters, meanLuminance, mode) {
    var base = pickBaseCluster(clusters, mode);
    var hue = base.hsl.h;
    var baseSaturation = Math.min(base.hsl.s, 0.5);
    var palette = {};
    var backgroundHex;

    if (mode === MODE_DARK) {
      var backgroundLightness = clamp(0.04 + baseSaturation * 0.1, 0.04, 0.1);
      var surfaceLightness = [
        clamp(backgroundLightness + 0.04, 0.04, 0.14),
        clamp(backgroundLightness + 0.08, 0.06, 0.18),
        clamp(backgroundLightness + 0.13, 0.09, 0.24)
      ];
      var surfaceSaturation = Math.min(baseSaturation * 0.55, 0.12);

      palette.bg = hslToHex({ h: hue, s: Math.min(baseSaturation * 0.4, 0.1), l: backgroundLightness });
      palette.surface1 = hslToHex({ h: hue, s: surfaceSaturation, l: surfaceLightness[0] });
      palette.surface2 = hslToHex({ h: hue, s: surfaceSaturation, l: surfaceLightness[1] });
      palette.surface3 = hslToHex({ h: hue, s: surfaceSaturation, l: surfaceLightness[2] });

      palette.text1 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.08), l: 0.96 });
      palette.text2 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.8 });
      palette.text3 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.58 });
      palette.text4 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.36 });

      palette.hairline = hueColor(hue, 1, 1, 0.08);
      palette.hairlineSoft = hueColor(hue, 1, 1, 0.06);
      palette.highlightTop = hueColor(hue, 1, 1, 0.07);
      palette.squircleHighlight = hueColor(hue, 1, 1, 0.16);
      palette.scrollThumb = hueColor(hue, 1, 1, 0.08);
      palette.scrollThumbHover = hueColor(hue, 1, 1, 0.2);
      palette.itemHover = hueColor(hue, 1, 1, 0.04);
      palette.tooltipBg = hueColor(hue, 0, 0, 0.92);
      palette.panelShadow = hueColor(hue, 0, 0, 0.42);
    } else {
      var lightBackground = clamp(0.96 - baseSaturation * 0.03, 0.93, 0.96);
      var lightSurfaces = [
        clamp(lightBackground - 0.035, 0.9, 0.95),
        clamp(lightBackground - 0.07, 0.86, 0.93),
        clamp(lightBackground - 0.11, 0.82, 0.9)
      ];
      var lightSurfaceSaturation = Math.min(baseSaturation * 0.6, 0.1);

      palette.bg = hslToHex({ h: hue, s: Math.min(baseSaturation * 0.35, 0.08), l: lightBackground });
      palette.surface1 = hslToHex({ h: hue, s: lightSurfaceSaturation, l: lightSurfaces[0] });
      palette.surface2 = hslToHex({ h: hue, s: lightSurfaceSaturation, l: lightSurfaces[1] });
      palette.surface3 = hslToHex({ h: hue, s: lightSurfaceSaturation, l: lightSurfaces[2] });

      palette.text1 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.1 });
      palette.text2 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.36 });
      palette.text3 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.5 });
      palette.text4 = hslToHex({ h: hue, s: Math.min(baseSaturation, 0.1), l: 0.68 });

      palette.hairline = hueColor(hue, 0, 0, 0.1);
      palette.hairlineSoft = hueColor(hue, 0, 0, 0.07);
      palette.highlightTop = hueColor(hue, 0, 0, 0.06);
      palette.squircleHighlight = hueColor(hue, 0, 0, 0.14);
      palette.scrollThumb = hueColor(hue, 0, 0, 0.16);
      palette.scrollThumbHover = hueColor(hue, 0, 0, 0.3);
      palette.itemHover = hueColor(hue, 0, 0, 0.05);
      palette.tooltipBg = hueColor(hue, 0, 0, 0.9);
      palette.panelShadow = hueColor(hue, 0, 0, 0.18);
    }

    var accentCluster = pickAccentCluster(clusters);
    palette.accent = accentCluster ? accentFromCluster(accentCluster) : CLASSIC_PALETTE.accent;

    backgroundHex = palette.bg;
    var report = {};
    var backgroundLuminance = relativeLuminance(hexToRgb(backgroundHex));
    var preferLighterText = backgroundLuminance < 0.5;

    var strongKeys = ['text1', 'text2'];
    for (var i = 0; i < strongKeys.length; i += 1) {
      var key = strongKeys[i];
      var currentRgb = hexToRgb(palette[key]);
      if (!currentRgb) continue;
      var tuned = tuneLightness(rgbToHsl(currentRgb), backgroundHex, TARGET_TEXT_STRONG, preferLighterText);
      palette[key] = hslToHex(tuned.hsl);
    }
    var mutedRgb = hexToRgb(palette.text3);
    if (mutedRgb) {
      var muted = tuneLightness(rgbToHsl(mutedRgb), backgroundHex, TARGET_TEXT_MUTED, preferLighterText);
      palette.text3 = hslToHex(muted.hsl);
    }

    var strong1 = tuneLightness(
      rgbToHsl(hexToRgb(palette.text1)),
      palette.surface1,
      TARGET_TEXT_STRONG,
      relativeLuminance(hexToRgb(palette.surface1)) < 0.5
    );
    if (strong1.ratio >= contrastRatio(palette.text1, palette.surface1)) {
      palette.text1 = hslToHex(strong1.hsl);
    }

    // 实测对比度：全部来自 contrastRatio 的真实计算，不写死数值。
    report['text1/bg'] = round2(contrastRatio(palette.text1, palette.bg));
    report['text2/bg'] = round2(contrastRatio(palette.text2, palette.bg));
    report['text3/bg'] = round2(contrastRatio(palette.text3, palette.bg));
    report['text1/surface1'] = round2(contrastRatio(palette.text1, palette.surface1));
    report.mode = mode;

    return { palette: palette, report: report };
  }

  function generateFromClusters(clusters, meanLuminance) {
    var mode = meanLuminance <= MODE_LUMINANCE_THRESHOLD ? MODE_DARK : MODE_LIGHT;
    var built = buildPalette(clusters, meanLuminance, mode);
    var palette = normalizePalette(built.palette);
    if (!palette) return { ok: false, error: 'invalid_image' };
    return { ok: true, mode: mode, palette: palette, report: built.report };
  }

  /* -------------------------------------------------------------- 校验归一 */

  function isColorString(value) {
    if (typeof value !== 'string') return false;
    var text = value.trim();
    return HEX_RE.test(text) || RGB_RE.test(text);
  }

  function normalizePalette(value) {
    if (!value || typeof value !== 'object') return null;
    var result = {};
    for (var index = 0; index < PALETTE_KEYS.length; index += 1) {
      var key = PALETTE_KEYS[index];
      if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
      var color = value[key];
      if (!isColorString(color)) return null;
      result[key] = color.trim();
    }
    return result;
  }

  /* ------------------------------------------------------------ CSS 注入 */

  var APPLIED_VARIABLES = [];

  var APP_VARIABLES = {
    bg: '--bg-base',
    surface1: '--surface-1',
    surface2: '--surface-2',
    surface3: '--surface-3',
    hairline: '--hairline',
    hairlineSoft: '--hairline-soft',
    highlightTop: '--highlight-top',
    squircleHighlight: '--squircle-highlight',
    text1: '--text-1',
    text2: '--text-2',
    text3: '--text-3',
    text4: '--text-4',
    accent: '--focus-ring',
    scrollThumb: '--scrollbar-thumb',
    scrollThumbHover: '--scrollbar-thumb-hover',
    tooltipBg: '--tooltip-bg',
    itemHover: '--item-hover',
    panelShadow: '--panel-shadow'
  };

  var NOTIFICATION_VARIABLES = {
    bg: '--color-shell',
    surface1: '--color-shell-hover',
    surface2: '--color-surface',
    hairline: '--color-border',
    squircleHighlight: '--color-border-strong',
    text1: '--color-text-primary',
    text2: '--color-text-secondary',
    text3: '--color-text-tertiary',
    accent: '--color-focus'
  };

  var COMMON_VARIABLES = {
    bg: '--palette-bg',
    surface1: '--palette-surface-1',
    surface2: '--palette-surface-2',
    surface3: '--palette-surface-3',
    hairline: '--palette-hairline',
    text1: '--palette-text-1',
    text2: '--palette-text-2',
    text3: '--palette-text-3',
    accent: '--palette-accent',
    panelShadow: '--palette-shadow'
  };

  function setVariable(style, name, value) {
    style.setProperty(name, value);
    if (APPLIED_VARIABLES.indexOf(name) < 0) APPLIED_VARIABLES.push(name);
  }

  function writeMapping(style, mapping, palette) {
    var keys = Object.keys(mapping);
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      setVariable(style, mapping[key], palette[key]);
    }
  }

  function apply(palette, surface) {
    var normalized = normalizePalette(palette);
    if (!normalized) return false;
    var target = surface || 'app';
    if (!SURFACES[target]) return false;
    if (typeof global.document === 'undefined' || !global.document.documentElement) return false;

    var root = global.document.documentElement;
    var style = root.style;

    writeMapping(style, COMMON_VARIABLES, normalized);
    if (target === 'app') writeMapping(style, APP_VARIABLES, normalized);
    if (target === 'notification') writeMapping(style, NOTIFICATION_VARIABLES, normalized);

    // 黑玻璃的分层全靠白色半透明叠加。照片主题生成浅色底时，白色叠加会糊在
    // 浅底上，所以整条叠加通道一起翻成黑色——styles.css 里 155 处调用点共用
    // --overlay-rgb，一次翻转全部生效。深色底维持 255,255,255。
    var background = parseColor(normalized.bg);
    var overlayChannel = background && relativeLuminance(background) > 0.5 ? '0,0,0' : '255,255,255';
    setVariable(style, '--overlay-rgb', overlayChannel);

    root.dataset.theme = 'photo';
    return true;
  }

  function clear() {
    if (typeof global.document === 'undefined' || !global.document.documentElement) return false;
    var root = global.document.documentElement;
    var style = root.style;
    for (var index = 0; index < APPLIED_VARIABLES.length; index += 1) {
      style.removeProperty(APPLIED_VARIABLES[index]);
    }
    APPLIED_VARIABLES = [];
    delete root.dataset.theme;
    return true;
  }

  /* ------------------------------------------------------------------- API */

  function generateFromImage(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.length) {
      return Promise.resolve({ ok: false, error: 'invalid_image' });
    }
    if (
      typeof global.document === 'undefined' ||
      typeof global.Image === 'undefined' ||
      typeof global.Promise === 'undefined'
    ) {
      return Promise.resolve({ ok: false, error: 'invalid_image' });
    }
    return loadImage(dataUrl).then(function (image) {
      if (!image) return { ok: false, error: 'invalid_image' };
      var sampled = drawSampled(image);
      if (!sampled) return { ok: false, error: 'invalid_image' };
      var collected = collectSamples(sampled);
      if (!collected) return { ok: false, error: 'invalid_image' };
      var clusters = quantize(collected.samples);
      if (!clusters.length) return { ok: false, error: 'invalid_image' };
      var generated = generateFromClusters(clusters, collected.meanLuminance);
      if (!generated || !generated.ok) return { ok: false, error: 'invalid_image' };
      return generated;
    }).catch(function () {
      // 任何意外（异常像素、canvas 被回收等）都收敛为契约内的失败值，绝不向外抛。
      return { ok: false, error: 'invalid_image' };
    });
  }

  global.NotchTheme = {
    generateFromImage: generateFromImage,
    apply: apply,
    clear: clear,
    normalizePalette: normalizePalette,
    CLASSIC_PALETTE: CLASSIC_PALETTE
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.NotchTheme;
  }
})(typeof window !== 'undefined' ? window : this);
