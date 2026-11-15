import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import { coglContext } from '../shellVersion.js';
import { configureSamplerLayer } from './pipelines.js';
// A pixel keeps its opacity in proportion to how far its colour is from its
// neighbours' within 3 px, so text and borders stay solid (with a thin halo
// that helps them read over a busy backdrop) while flat background lets the
// glass through. Alpha is left out of the comparison: a window's edge and its
// CSD shadow are not detail and must not grow a solid rim.
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
vec3 cc = ckUnpremul(c);
vec2 texel = vec2(ck_tx, ck_ty);
float detail = 0.0;
for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.7853982;
    vec2 dir = vec2(cos(ang), sin(ang));
    for (int j = 1; j <= 3; j++) {
        float r = float(j);
        vec4 s = texture2D(cogl_sampler0, uv + dir * r * texel);
        float w = min(c.a, s.a) * exp(-(r - 1.0) * 0.8);
        detail = max(detail, distance(cc, ckUnpremul(s)) * w);
    }
}
float keep = mix(ck_opacity, 1.0, smoothstep(0.03, 0.18, detail));
cogl_color_out = c * (keep * ck_paint);
`;

/** Put on a window's surface: its flat background goes translucent, its content does not. */
export const ContentKey = GObject.registerClass(class ContentKey extends Clutter.OffscreenEffect {
    _init() {
        super._init();
        this._pipeline = null;
        this._opacity = 1;
    }

    /** Opacity (0 to 1) of the flat background areas. */
    setOpacity(opacity) {
        if (this._opacity === opacity)
            return;
        this._opacity = opacity;
        this.queue_repaint();
    }

    vfunc_paint_target(node, _paintContext) {
        const texture = this.get_texture();
        if (!texture)
            return;
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
