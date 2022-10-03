/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["ColorUtils"];

/**
 * Given a hex string (e.g. "#a3f333", return the corresponding triple of RGB
 * integer values between 0 and 255.
 *
 * @param hexString A hex string, e.g. "#a3f333".
 * @return An array of RGB integer values between 0 and 255.
 */
function hex2rgb(hexString) {
  var red, green, blue;
  var triplet = hexString.toLowerCase().replace(/#/, '');
  var rgbArr  = new Array();

  if (triplet.length === 6) {
    red = parseInt(triplet.substr(0,2), 16);
    green = parseInt(triplet.substr(2,2), 16);
    blue = parseInt(triplet.substr(4,2), 16);
  } else if (triplet.length === 3) {
    red = parseInt((triplet.substr(0,1) + triplet.substr(0,1)), 16);
    green = parseInt((triplet.substr(1,1) + triplet.substr(1,1)), 16);
    blue = parseInt((triplet.substr(2,2) + triplet.substr(2,2)), 16);
  }
  return [red, green, blue];
}

/**
 * Clamp an input value to fit between the low and high limits.
 *
 * @param value The value to clamp.
 * @param low The minimum value.
 * @param high The maximum value.
 */
function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * A Color object has four attributes, r (red), g (green), b (blue), and
 * a (transparency, aka alpha).
 */
class Color {
  /**
   * Create a new Color object.
   *
   * @param r The red value (0-255).
   * @param g The green value (0-255).
   * @param b The blue value (0-255).
   * @param a The alpha value (0-1).
   */
  constructor(r, g, b, a) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = (a === undefined) ? 1.0 : a;
  }

  /**
   * Return the HSV (hue, saturation, value) corresponding to the color, as a
   * triple.
   */
  toHSV() {
    const onethird = 1.0 / 3.0;

    const r = this.r / 255.0;
    const g = this.g / 255.0;
    const b = this.b / 255.0;

    const vmax = Math.max(r, g, b);
    const vmin = Math.min(r, g, b);
    const vdelta = vmax - vmin;

    let h, s, v;

    if (vmax == vmin)
      h = 0.0;
    else if (vmax == r && g >= b)
      h = (g - b) / (vdelta * 6.0);
    else if (vmax == r && g < b)
      h = (g - b) / (vdelta * 6.0) + 1.0;
    else if (vmax == g)
      h = (b - r) / (vdelta * 6.0) + onethird;
    else // vmax == b
      h = (r - g) / (vdelta * 6.0) + 2 * onethird;

    if (vmax == 0)
        s = 0;
    else
        s = 1 - vmin/vmax;
    v = vmax;

    return [h, s, v];
  }

  /**
   * Return the HSL (Hue, Saturation, Lightness) corresponding to the color, as
   * a triple.
   */
  toHSL() {
    const onethird = 1.0 / 3.0;

    const r = this.r / 255.0;
    const g = this.g / 255.0;
    const b = this.b / 255.0;

    const vmax = Math.max(r, g, b);
    const vmin = Math.min(r, g, b);
    const vdelta = vmax - vmin;

    if (vmax == vmin)
      h = 0.0;
    else if (vmax == r && g >= b)
      h = (g - b) / (vdelta * 6.0);
    else if (vmax == r && g < b)
      h = (g - b) / (vdelta * 6.0) + 1.0;
    else if (vmax == g)
      h = (b - r) / (vdelta * 6.0) + onethird;
    else // vmax == b
      h = (r - g) / (vdelta * 6.0) + 2 * onethird;

    l = 0.5 * (vmax + vmin);

    if (l == 0 || vdelta == 0)
        s = 0;
    else if (l <= 0.5)
        s = vdelta / (2 * l);
    else // l > 0.5
        s = vdelta / (2 - 2 * l);

    return [h, s, l];
  }

  /**
   * Make the color lighter by a specified step (10% is the default)
   * This is done by converting the value to HSL, and boosting the Lightness
   * component (clamped).
   *
   * @param step The step to lighten the color by.
   * @return The lightened color, as a Color object.
   */
  lighten(step) {
    if (step === undefined)
      step = 0.1;
    let [h, s, l] = this.toHSL();
    l = clamp(l + step, 0, 1);
    return hsla(h, s, l, this.a);
  }

  /**
   * Make the color darker by a specified step (10% is the default)
   * This is done by converting the value to HSL, and decreasing the Lightness
   * component (clamped).
   *
   * @param step The step to darken the color by.
   * @return The darkened color, as a Color object.
   */
  darken(step) {
    if (step === undefined)
      step = 0.1;
    let [h, s, l] = this.toHSL();
    l = clamp(l - step, 0, 1);
    return hsla(h, s, l, this.a);
  }

  /**
   * make the color brigther by a specified step (10% is the default)
   * This is done by converting the value to HSV, and boosting the value
   * component (clamped).
   *
   * @param step The step to brighten the color by.
   * @return The brightened color, as a Color object.
   */
  brighten(step) {
    if (step === undefined)
      step = 0.1;
    let [h, s, v] = this.toHSV();
    v = clamp(v + step, 0, 1);
    return hsva(h, s, v, this.a);
  }

  /**
   * Return a string representation of the color, using the rgba() notation,
   * e.g.: "rgba(100,200,300,0.2)".
   */
  toString() {
    return "rgba(" + this.r + "," + this.g + "," + this.b + "," + this.a + ")";
  }

  /**
   * Return a string representation of the color using the hex notation, e.g:
   * "#a3b1c9".
   */
  toHex() {
    return "#" + dec2hex(this.r) + dec2hex(this.g) + dec2hex(this.b);
  }
}

const HCHARS = "0123456789ABCDEF";

/**
 * Convert an integer in the range [0, 255] to a hex pair in the range [00, FF].
 *
 * @param n The number to convert.
 * @return The hex equivalent.
 */
function dec2hex(n) {
  n = (n > 255 || n < 0) ? 0 : n;
  return HCHARS.charAt((n - n % 16) / 16) + HCHARS.charAt(n % 16);
}

/**
 * Wrap the input value around 1. This is similar to v % 1.0, except that the
 * range of outputs is [0, 1], inclusive. FIXME: This fails for inputs outside
 * the range [-1, 2].
 *
 * @param v The input value.
 * @return The wrapped value.
 */
function _wrappy(v) {
  if (v < 0)
    return v + 1.0;
  else if (v > 1)
    return v - 1.0;
  else
    return v;
}

function _hsl_Tc(tc, p, q) {
  let Ti = Math.floor(tc * 6);
  let v;
  if (Ti == 0)
    v = p + ((q - p) * 6.0 * tc);
  else if (Ti < 3)
    v = q;
  else if (Ti < 4)
    v = p + ((q - p) * (2.0/3.0 - tc) * 6.0);
  else
    v = p;
  return Math.floor(255 * v);
}

/**
 * Return a Color object specified by hue, saturation, lightness, and alpha
 * values.
 *
 * @param hue Hue, between 0 and 2*PI.
 * @param saturation Saturation, between 0 and 1.
 * @param lightness Lightness, between 0 and 1.
 * @param alpha Alpha, between 0 and 1.
 * @return The Color object.
 */
function hsla(hue, saturation, lightness, alpha) {
  const onethird = 1.0 / 3.0;
  let q, p, Tr, Tg, Tb;
  if (lightness < 0.5)
    q = lightness * (1.0 + saturation);
  else
    q = lightness + saturation - (lightness * saturation);

  p = 2.0 * lightness - q;

  Tr = _wrappy(hue + onethird);
  Tg = hue;
  Tb = _wrappy(hue - onethird);

  return new Color(
    _hsl_Tc(Tr, p, q),
    _hsl_Tc(Tg, p, q),
    _hsl_Tc(Tb, p, q),
    alpha
  );
}

/**
 * Return a Color object specified by hue, saturation, value, and alpha values.
 *
 * @param hue Hue, between 0 and 2*PI.
 * @param saturation Saturation, between 0 and 1.
 * @param value Value, between 0 and 1.
 * @param alpha Alpha, between 0 and 1.
 * @return The Color object.
 */
function hsva(hue, saturation, value, alpha) {
  if (saturation < 0.0) {
    let vi = Math.floor(value * 255);
    return new Color(vi, vi, vi, alpha);
  }

  if (hue >= 1.0)
    hue = 0.0;

  const Hi = Math.floor(hue * 6) % 6;
  const f = hue * 6 - Hi;
  let p = value * (1 - saturation);
  let q = value * (1 - f * saturation);
  let t = value * (1 - (1 - f) * saturation);

  // Map into 0-255 space.
  value = Math.floor(value * 255);
  p = Math.floor(p * 255);
  q = Math.floor(q * 255);
  t = Math.floor(t * 255);

  if (Hi === 0)
    return new Color(value, t, p, alpha);
  else if (Hi === 1)
    return new Color(q, value, p, alpha);
  else if (Hi === 2)
    return new Color(p, value, t, alpha);
  else if (Hi === 3)
    return new Color(p, q, value, alpha);
  else if (Hi === 4)
    return new Color(t, p, value, alpha);
  else // Hi === 5
    return new Color(value, p, q, alpha);
}

/**
 * Create a Color object from a computed CSS color value.
 *
 * @param style The CSS value.
 * @return The Color object.
 */
function colorFromStyle(style) {
  const re = /(?:rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+))?\)/;
  const v = re.exec(style);
  return new Color(parseInt(v[1]), parseInt(v[2]), parseInt(v[3]));
}

/**
 * Create a Color object complementing a pair of input colors.
 *
 * @param c1 The first color.
 * @param c2 The second color.
 * @return The new, complementary color.
 */
function complement(c1, c2) {
  const [h1, s1, v1] = c1.toHSV();
  const [h2, s2, v2] = c2.toHSV();

  const h = ((s1 > s2 ? h1 : h2) + 0.5) % 1.0;
  if (Math.max(s1, s2) < 0.1) {
    const vmax = Math.max(v1, v2);
    const vmin = Math.min(v1, v2);

    const s = Math.max(s1, s2);
    let v;
    if (vmax - vmin > 0.5)
      v = (v1 + v2) / 2;
    else if (vmin > 1 - vmax)
      v = clamp(2 * vmin - vmax);
    else
      v = clamp(2 * vmax - vmin);

    return hsva(h, s, v);
  } else {
    const s = 1 - Math.min(s1, s2);
    const v = Math.max(v1, v2);
    return hsva(h, s, v);
  }
}

const ColorUtils = {
  clamp,
  Color,
  colorFromStyle,
  complement,
  hex2rgb,
  hsva,
  hsla,
};
