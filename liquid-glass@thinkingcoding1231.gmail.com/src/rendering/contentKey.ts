import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { coglContext } from '../shellVersion.js';
import { configureSamplerLayer } from './pipelines.js';

// Replaces a window's own background with the glass. The background behind a
// pixel is the colour most of 16 surrounding samples share, so it follows the
// app's palette (and a header bar next to a terminal) without configuration.
// The pixel is then split into a foreground over that colour, as GIMP's
// "colour to alpha" does: flat background goes clear, anti-aliased glyph
// edges keep their coverage instead of a halo, and strong strokes stay solid
// in their own colour. Where no colour dominates (a photo, a gradient) the
// pixel is left alone. Samples outside the window's opaque area do not vote,
// so its rounded corners and CSD shadow are not mistaken for background.
const DECL = `
uniform float ck_tx;
uniform float ck_ty;
uniform float ck_opacity;
uniform float ck_paint;

vec3 ckUnpremul(vec4 c) {
    return c.a > 0.004 ? c.rgb / c.a : vec3(0.0);
}
`;
const BODY = `
vec2 uv = cogl_tex_coord_in[0].st;
vec4 c = texture2D(cogl_sampler0, uv);
vec2 texel = vec2(ck_tx, ck_ty);
vec3 cs[16];
float ca[16];
for (int i = 0; i < 16; i++) {
    float ring = i < 8 ? 0.0 : 1.0;
    float ang = float(i) * 0.7853982 + ring * 0.3926991;
    vec4 t = texture2D(cogl_sampler0, uv + vec2(cos(ang), sin(ang)) * (6.0 + 6.0 * ring) * texel);
    cs[i] = ckUnpremul(t);
    ca[i] = t.a;
}
float votes = 0.0;
vec3 bg = vec3(0.0);
for (int i = 0; i < 16; i++) {
    if (ca[i] < 0.95)
        continue;
    float n = 0.0;
    for (int j = 0; j < 16; j++) {
        if (ca[j] >= 0.95 && distance(cs[i], cs[j]) < 0.035)
            n += 1.0;
    }
    if (n > votes) {
        votes = n;
        bg = cs[i];
    }
}
if (votes < 6.0 || c.a < 0.004) {
    cogl_color_out = c * ck_paint;
} else {
    vec3 p = c.rgb / c.a;
    vec3 up = max(p - bg, 0.0) / max(1.0 - bg, 0.001);
    vec3 down = max(bg - p, 0.0) / max(bg, 0.001);
    float coverage = clamp(max(max(max(up.r, up.g), up.b), max(max(down.r, down.g), down.b)), 0.0, 1.0);
    // Most glyph pixels separate to 60-80 % coverage; lifting them to solid
    // keeps text as legible as it was, the rest stays a soft edge.
    float solid = clamp(coverage * 1.6, 0.0, 1.0);
    vec3 fg = solid > 0.0 ? clamp(bg + (p - bg) / solid, 0.0, 1.0) : bg;
    vec4 keyed = vec4(fg * solid, solid) + vec4(bg, 1.0) * (ck_opacity * (1.0 - solid));
    cogl_color_out = keyed * (c.a * ck_paint);
}
`;

/** Put on a window's surface: its own background colours give way to the glass, its content does not. */
export const ContentKey = GObject.registerClass(
  class ContentKey extends Clutter.OffscreenEffect {
    declare private _pipeline: Cogl.Pipeline | null;
    declare private _opacity: number;

    _init(): void {
      super._init();
      this._pipeline = null;
      this._opacity = 1;
    }

    /** How much of the window's own background colour stays over the glass (0 to 1). */
    setOpacity(opacity: number): void {
      if (this._opacity === opacity) return;
      this._opacity = opacity;
      this.queue_repaint();
    }

    vfunc_paint_target(node: Clutter.PaintNode, _paintContext: Clutter.PaintContext): void {
      const texture = this.get_texture();
      if (!texture) return;
      if (!this._pipeline) {
        this._pipeline = Cogl.Pipeline.new(coglContext());
        configureSamplerLayer(this._pipeline, 0);
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECL, null);
        snippet.set_replace(BODY);
        this._pipeline.add_snippet(snippet);
      }
      const p = this._pipeline;
      const w = texture.get_width();
      const h = texture.get_height();
      p.set_layer_texture(0, texture);
      p.set_uniform_1f(p.get_uniform_location('ck_tx'), 1 / Math.max(w, 1));
      p.set_uniform_1f(p.get_uniform_location('ck_ty'), 1 / Math.max(h, 1));
      p.set_uniform_1f(p.get_uniform_location('ck_opacity'), this._opacity);
      p.set_uniform_1f(p.get_uniform_location('ck_paint'), this.get_actor().get_paint_opacity() / 255);
      const drawNode = Clutter.PipelineNode.new(p);
      node.add_child(drawNode);
      drawNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: w, y2: h }));
    }
  });
export type ContentKey = InstanceType<typeof ContentKey>;
