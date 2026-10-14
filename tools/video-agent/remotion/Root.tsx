import { Composition, type CalculateMetadataFunction } from 'remotion';
import { DEFAULT_DURATION, FPS, normalizeDuration, type VideoConfig } from '../src/config';
import { AdVideo } from './templates/AdVideo';

export const defaultVideoProps: VideoConfig = {
  duration: DEFAULT_DURATION,
  title: 'عنوان',
  subtitle: 'نص فرعي',
  backgroundColor: '#000000',
  textColor: '#FFFFFF',
  accentColor: '#D4AF37',
};

export const calculateAdMetadata: CalculateMetadataFunction<VideoConfig> = ({ props }) => {
  const duration = normalizeDuration(props.duration);
  return {
    durationInFrames: duration * FPS,
    fps: FPS,
    width: 1080,
    height: 1080,
    props: { ...props, duration },
  };
};

export const RemotionRoot = () => (
  <Composition
    id="AdVideo"
    component={AdVideo}
    durationInFrames={DEFAULT_DURATION * FPS}
    fps={FPS}
    width={1080}
    height={1080}
    calculateMetadata={calculateAdMetadata}
    defaultProps={defaultVideoProps}
  />
);
