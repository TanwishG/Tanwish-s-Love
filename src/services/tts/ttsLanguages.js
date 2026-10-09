// Languages offered by /tts (Google Translate TTS codes). Discord allows at most 25 choices.
export const TTS_LANGUAGES = [
    { name: 'English', value: 'en' },
    { name: 'Hindi', value: 'hi' },
    { name: 'Gujarati', value: 'gu' },
    { name: 'Marathi', value: 'mr' },
    { name: 'Bengali', value: 'bn' },
    { name: 'Tamil', value: 'ta' },
    { name: 'Telugu', value: 'te' },
    { name: 'Urdu', value: 'ur' },
    { name: 'Spanish', value: 'es' },
    { name: 'French', value: 'fr' },
    { name: 'German', value: 'de' },
    { name: 'Italian', value: 'it' },
    { name: 'Portuguese', value: 'pt' },
    { name: 'Russian', value: 'ru' },
    { name: 'Japanese', value: 'ja' },
    { name: 'Korean', value: 'ko' },
    { name: 'Chinese (Simplified)', value: 'zh-CN' },
    { name: 'Arabic', value: 'ar' },
    { name: 'Indonesian', value: 'id' },
    { name: 'Vietnamese', value: 'vi' },
    { name: 'Turkish', value: 'tr' },
    { name: 'Dutch', value: 'nl' },
    { name: 'Polish', value: 'pl' },
    { name: 'Thai', value: 'th' },
];

export const DEFAULT_TTS_LANGUAGE = 'en';

const CODES = new Set(TTS_LANGUAGES.map((l) => l.value));

export function isSupportedTtsLanguage(code) {
    return CODES.has(code);
}

export function getLanguageName(code) {
    return TTS_LANGUAGES.find((l) => l.value === code)?.name || code;
}
