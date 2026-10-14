import { Composition, type CalculateMetadataFunction } from 'remotion';
import { normalizeDuration, videoConfigSchema, type VideoConfig } from '../src/config';
import { AdVideo } from './templates/AdVideo';

export const defaultVideoProps: VideoConfig = {
  duration: 15, fps: 30, width: 1080, height: 1080,
  script: { duration: 15, lang: 'ar', category: 'perfume', productName: 'عطرك',
    hook: 'عطرك يحكي عنك', body: 'لمسة تكمّل إطلالتك', cta: 'اكتشفه اليوم' },
  backgroundColor: '#101018', accentColor: '#D4AF37', textColor: '#FFFFFF',
  media: { logo: 'logo.svg' },
};
export const calculateAdMetadata: CalculateMetadataFunction<VideoConfig> = ({ props }) => {
  const normalized = videoConfigSchema.parse({ ...props, duration: normalizeDuration(props.duration) });
  return { durationInFrames: normalized.duration * normalized.fps, fps: normalized.fps,
    width: normalized.width, height: normalized.height, props: normalized };
};
export const RemotionRoot = () => (
  <Composition id="AdVideo" component={AdVideo} durationInFrames={450} fps={30} width={1080} height={1080}
    calculateMetadata={calculateAdMetadata} defaultProps={defaultVideoProps} />
);
