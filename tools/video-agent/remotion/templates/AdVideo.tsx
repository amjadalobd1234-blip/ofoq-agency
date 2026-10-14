import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoConfig } from '../../src/config';

export const AdVideo = ({
  title,
  subtitle,
  backgroundColor,
  textColor,
  accentColor,
}: VideoConfig) => {
  const frame = useCurrentFrame();
  // Metadata converts the duration prop into the composition's frame count.
  const { durationInFrames } = useVideoConfig();
  // Last rendered frame is N-1: the fade must reach zero on that frame.
  const progress = frame / Math.max(1, durationInFrames - 1);
  const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
  const bgOpacity = interpolate(progress, [0, 0.07], [0, 1], clamp);
  const titleX = interpolate(progress, [0.07, 0.2], [-200, 0], clamp);
  const titleOpacity = interpolate(progress, [0.07, 0.2], [0, 1], clamp);
  const subtitleOpacity = interpolate(progress, [0.2, 0.4], [0, 1], clamp);
  const endOpacity = interpolate(progress, [0.8, 1], [1, 0], clamp);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <AbsoluteFill
        dir="rtl"
        style={{
          backgroundColor,
          opacity: bgOpacity * endOpacity,
          justifyContent: 'center',
          alignItems: 'center',
          fontFamily: 'system-ui, Arial, sans-serif',
          padding: 80,
          textAlign: 'center',
          overflow: 'hidden',
        }}
      >
        <div
          dir="auto"
          style={{
            transform: `translateX(${titleX}px)`,
            opacity: titleOpacity,
            fontSize: 100,
            fontWeight: 'bold',
            color: textColor,
            marginBottom: 30,
            width: '100%',
            lineHeight: 1.35,
            overflowWrap: 'anywhere',
          }}
        >
          {title}
        </div>
        <div
          dir="auto"
          style={{
            opacity: subtitleOpacity,
            fontSize: 50,
            color: accentColor,
            width: '100%',
            lineHeight: 1.6,
            overflowWrap: 'anywhere',
          }}
        >
          {subtitle}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
