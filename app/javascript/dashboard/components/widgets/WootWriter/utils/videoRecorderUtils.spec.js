import {
  pickRecorderMimeType,
  filenameFor,
} from './videoRecorderUtils';

const supports = (...allowed) => {
  const set = new Set(allowed);
  return mt => set.has(mt);
};

describe('videoRecorderUtils', () => {
  describe('pickRecorderMimeType', () => {
    it('prefers H.264 baseline + AAC mp4 when everything is supported', () => {
      const pick = pickRecorderMimeType(() => true);
      expect(pick.mimeType).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
      expect(pick.ext).toBe('mp4');
      expect(pick.isMp4).toBe(true);
    });

    it('picks the first supported candidate in priority order', () => {
      const pick = pickRecorderMimeType(
        supports('video/mp4;codecs=avc1.4D401E,mp4a.40.2', 'video/webm')
      );
      expect(pick.mimeType).toBe('video/mp4;codecs=avc1.4D401E,mp4a.40.2');
    });

    it('falls back to webm when no mp4 variant is supported', () => {
      const pick = pickRecorderMimeType(
        supports('video/webm;codecs=vp8,opus', 'video/webm')
      );
      expect(pick.mimeType).toBe('video/webm;codecs=vp8,opus');
      expect(pick.isMp4).toBe(false);
    });

    it('returns null when nothing is supported', () => {
      expect(pickRecorderMimeType(() => false)).toBeNull();
    });
  });

  describe('filenameFor', () => {
    it('uses an mp4 extension for any mp4 mime', () => {
      expect(filenameFor('video/mp4', '7')).toBe('gravacao-7.mp4');
      expect(filenameFor('video/mp4;codecs=avc1.42E01E,mp4a.40.2', '1')).toBe(
        'gravacao-1.mp4'
      );
    });

    it('uses a webm extension for webm / unknown / empty mime', () => {
      expect(filenameFor('video/webm;codecs=vp8,opus', '9')).toBe(
        'gravacao-9.webm'
      );
      expect(filenameFor('', '9')).toBe('gravacao-9.webm');
      expect(filenameFor(null, '9')).toBe('gravacao-9.webm');
    });

    it('drops the timestamp segment when none is given', () => {
      expect(filenameFor('video/mp4')).toBe('gravacao.mp4');
    });
  });
});
