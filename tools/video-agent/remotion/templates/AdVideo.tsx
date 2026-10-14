import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { sceneFrames, type VideoConfig } from '../../src/config';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const AdVideo = ({ script, backgroundColor, accentColor, textColor, media }: VideoConfig) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps, width } = useVideoConfig();
  const plan = sceneFrames(durationInFrames / fps, fps);
  const fadeLength = Math.max(2, Math.round(durationInFrames * .035));
  const introOpacity = interpolate(frame, [0, fadeLength, plan.bodyStart - fadeLength, plan.bodyStart], [0, 1, 1, 0], clamp);
  const bodyOpacity = interpolate(frame, [plan.bodyStart, plan.bodyStart + fadeLength, plan.ctaStart - fadeLength, plan.ctaStart], [0, 1, 1, 0], clamp);
  const ctaOpacity = interpolate(frame, [plan.ctaStart, plan.ctaStart + fadeLength, plan.speechEnd, durationInFrames - 1], [0, 1, 1, 0], clamp);
  const finalOpacity = interpolate(frame, [plan.speechEnd, durationInFrames - 1], [1, 0], clamp);
  const musicVolume = (f: number) => .13 * interpolate(f, [0, fadeLength, plan.speechEnd, durationInFrames - 1], [0, 1, 1, 0], clamp);
  const scale = width / 1080;
  const typography = { width: '100%', textAlign: 'center' as const, overflowWrap: 'anywhere' as const, lineHeight: 1.45 };
  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      {media.font && <style>{`@font-face { font-family: OfoqLocal; src: url('${staticFile(media.font)}') format('woff2'); }`}</style>}
      <AbsoluteFill dir={script.lang === 'ar' ? 'rtl' : 'ltr'} style={{
        color: textColor, fontFamily: 'OfoqLocal, system-ui, Arial, sans-serif', opacity: finalOpacity,
        background: `radial-gradient(ellipse at 15% 5%, ${accentColor}40, transparent 60%), linear-gradient(135deg, ${backgroundColor}, #05060A)`,
      }}>
        <div style={{ position: 'absolute', inset: 40 * scale, border: `1px solid ${accentColor}55`, borderRadius: 34 * scale }} />
        <AbsoluteFill style={{ padding: 100 * scale, alignItems: 'center', justifyContent: 'center', gap: 60 * scale, opacity: introOpacity }}>
          <Img src={staticFile(media.logo)} style={{ width: 220 * scale }} />
          <div style={{ ...typography, fontSize: Math.min(80, 420 / Math.sqrt(script.hook.length)) * scale, fontWeight: 700,
            transform: `translateY(${interpolate(frame, [0, fadeLength], [30, 0], clamp) * scale}px)` }}>{script.hook}</div>
          <div style={{ width: 100 * scale, height: 4 * scale, backgroundColor: accentColor }} />
        </AbsoluteFill>
        <Sequence from={plan.bodyStart} durationInFrames={plan.ctaStart - plan.bodyStart}>
          <AbsoluteFill style={{ padding: 70 * scale, alignItems: 'center', justifyContent: 'center', gap: 26 * scale, opacity: bodyOpacity }}>
            <div style={{ width: '65%', aspectRatio: '1', borderRadius: 36 * scale, overflow: 'hidden', border: `2px solid ${accentColor}88`, boxShadow: '0 30px 100px #0008' }}>
              {media.avatar && <OffthreadVideo src={staticFile(media.avatar)} startFrom={plan.bodyStart} muted
                style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <div style={{ ...typography, fontSize: 24 * scale, color: accentColor }}>{script.productName}</div>
            <div style={{ ...typography, fontSize: Math.min(48, 380 / Math.sqrt(script.body.length)) * scale, fontWeight: 600 }}>{script.body}</div>
          </AbsoluteFill>
        </Sequence>
        <Sequence from={plan.ctaStart}>
          <AbsoluteFill style={{ padding: 100 * scale, alignItems: 'center', justifyContent: 'center', gap: 55 * scale, opacity: ctaOpacity }}>
            <Img src={staticFile(media.logo)} style={{ width: 160 * scale }} />
            <div style={{ ...typography, color: accentColor, fontSize: 32 * scale }}>{script.productName}</div>
            <div style={{ ...typography, fontSize: Math.min(72, 400 / Math.sqrt(script.cta.length)) * scale, fontWeight: 700,
              borderTop: `2px solid ${accentColor}`, borderBottom: `2px solid ${accentColor}`, padding: 35 * scale }}>{script.cta}</div>
          </AbsoluteFill>
        </Sequence>
      </AbsoluteFill>
      {/* Avatar's embedded audio is muted: only this narration track is audible. */}
      {media.voice && <Audio src={staticFile(media.voice)} volume={.9} />}
      {media.music && <Audio src={staticFile(media.music)} volume={musicVolume} />}
    </AbsoluteFill>
  );
};
