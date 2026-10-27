export type Lang = 'en' | 'tr';
export const origin = 'https://local.sametbasbug.dev';
export const github = 'https://github.com/sametbasbug/equinox-local';
export const store = 'https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj';
export const installer = `${origin}/downloads/updates/install-equinox-local.sh`;
export const installCommand = `curl -fsSL ${installer} | /bin/bash`;
export const windowsInstaller = `${origin}/downloads/updates/install-equinox-local.ps1`;
export const windowsInstallCommand = `irm ${windowsInstaller} | iex`;
export const pathFor = (lang: Lang, page = '') => `${lang === 'tr' ? '/tr/' : '/'}${page ? page + '/' : ''}`;
export const ui = {
  en: {
    product: 'Explore', browser: 'Browser', install: 'Get started', security: 'Security', privacy: 'Privacy', contact: 'Contact', source: 'Source code',
    skip: 'Skip to content', nav: 'Main navigation', menu: 'Menu', language: 'Language', footer: 'Connect your agent in ChatGPT on the web to your computer.',
    ecosystem: 'Part of Equinox', rights: 'Built by Samet Başbuğ.', docs: 'Resources', code: 'Open source. Open to inspection.', mac: 'For macOS + Windows · ARM64 & x64',
  },
  tr: {
    product: 'Keşfet', browser: 'Tarayıcı', install: 'Başlayın', security: 'Güvenlik', privacy: 'Gizlilik', contact: 'İletişim', source: 'Kaynak kodu',
    skip: 'İçeriğe geç', nav: 'Ana menü', menu: 'Menü', language: 'Dil', footer: 'ChatGPT web’deki ajanınız ile bilgisayarınız arasında bir bağ.',
    ecosystem: 'Equinox ailesinden', rights: 'Samet Başbuğ tarafından geliştirildi.', docs: 'Kaynaklar', code: 'Açık kaynak. İncelemenize açık.', mac: 'macOS + Windows için · ARM64 ve x64',
  },
};
