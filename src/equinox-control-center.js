const $ = (id) => document.getElementById(id);

const LANGUAGE_STORAGE_KEY = "equinox-local-control-center-language";
const SUPPORTED_LANGUAGES = new Set(["en", "tr"]);
const EQUINOX_BROWSER_STORE_URL =
  "https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj";

const TR_UI = Object.freeze({
  "Equinox Local Control Center": "Equinox Local Kontrol Merkezi",
  "Primary navigation": "Ana gezinme",
  "Control Center": "Kontrol Merkezi",
  "Control Center sections": "Kontrol Merkezi bölümleri",
  "Dashboard": "Gösterge Paneli",
  "Projects & folders": "Projeler ve klasörler",
  "Browser": "Tarayıcı",
  "Permissions": "İzinler",
  "Integrations": "Entegrasyonlar",
  "Activity": "Etkinlik",
  "Connecting…": "Bağlanıyor…",
  "Local runtime": "Yerel runtime",
  "Loopback only · Private to this Mac": "Yalnızca loopback · Bu Mac'e özel",
  "Overview": "Genel Bakış",
  "Language": "Dil",
  "Control Center language": "Kontrol Merkezi dili",
  "Not refreshed yet": "Henüz yenilenmedi",
  "Restart": "Yeniden başlat",
  "Restarting…": "Yeniden başlatılıyor…",
  "Refresh": "Yenile",
  "Restart required": "Yeniden başlatma gerekli",
  "Your configuration was saved safely. Restart Equinox Local before making another configuration change.": "Yapılandırmanız güvenle kaydedildi. Başka bir yapılandırma değişikliği yapmadan önce Equinox Local'i yeniden başlatın.",
  "I restarted — reload": "Yeniden başlattım — yenile",
  "Control Center could not load everything": "Kontrol Merkezi her şeyi yükleyemedi",
  "Dismiss error": "Hatayı kapat",
  "First-time setup": "İlk kurulum",
  "Finish connecting Equinox Local": "Equinox Local bağlantısını tamamlayın",
  "Your local runtime is ready. Complete the remaining connection steps without using Terminal.": "Yerel runtime hazır. Kalan bağlantı adımlarını Terminal kullanmadan tamamlayın.",
  "Setup needed": "Kurulum gerekli",
  "Setup progress": "Kurulum ilerlemesi",
  "Installed and private to this Mac.": "Kurulu ve yalnızca bu Mac'e özel.",
  "Equinox Workspace": "Equinox Çalışma Alanı",
  "Your managed starter workspace.": "Yönetilen başlangıç çalışma alanınız.",
  "Equinox Browser": "Equinox Browser",
  "Optional. Install it separately from Chrome Web Store.": "İsteğe bağlı. Chrome Web Store'dan ayrıca yükleyin.",
  "Install extension ↗": "Uzantıyı yükle ↗",
  "Optional": "İsteğe bağlı",
  "ChatGPT connection": "ChatGPT bağlantısı",
  "Connect this Local runtime through your OpenAI tunnel.": "Bu Local runtime'ını OpenAI tunnel'ınız üzerinden bağlayın.",
  "Not connected": "Bağlı değil",
  "Connect to ChatGPT": "ChatGPT'ye bağlan",
  "Use a tunnel Runtime API key with Tunnels Read + Use. The key stays only on this Mac.": "Tunnels Read + Use yetkilerine sahip bir tunnel Runtime API anahtarı kullanın. Anahtar yalnızca bu Mac'te kalır.",
  "Tunnel ID": "Tunnel ID",
  "OpenAI tunnel IDs use": "OpenAI tunnel ID'leri",
  "followed by 32 lowercase hexadecimal characters.": "ardından 32 küçük harfli onaltılık karakter kullanır.",
  "Runtime API key": "Runtime API anahtarı",
  "This secret is written to a private 0600 file and is never returned by the Control Center API.": "Bu gizli değer özel bir 0600 dosyasına yazılır ve Kontrol Merkezi API'si tarafından hiçbir zaman geri döndürülmez.",
  "Open Tunnels": "Tunnels'ı aç",
  "Runtime API keys": "Runtime API anahtarları",
  "ChatGPT connectors": "ChatGPT bağlayıcıları",
  "Save & connect": "Kaydet ve bağlan",
  "Connecting…": "Bağlanıyor…",
  "Restart scheduled. Equinox Local will reconnect here automatically…": "Yeniden başlatma planlandı. Equinox Local buraya otomatik olarak yeniden bağlanacak…",
  "Checking runtime": "Runtime kontrol ediliyor",
  "Your local agent control plane, at a glance.": "Yerel ajan kontrol katmanınız, tek bakışta.",
  "See what is connected, what Equinox Local can reach, and whether anything needs your attention.": "Nelerin bağlı olduğunu, Equinox Local'in nelere erişebildiğini ve ilgilenmeniz gereken bir durum olup olmadığını görün.",
  "Runtime": "Runtime",
  "Uptime unavailable": "Çalışma süresi kullanılamıyor",
  "Checking…": "Kontrol ediliyor…",
  "Version unavailable": "Sürüm kullanılamıyor",
  "Desktop bridge": "Masaüstü köprüsü",
  "Control Center API": "Kontrol Merkezi API'si",
  "127.0.0.1 only": "Yalnızca 127.0.0.1",
  "Configuration": "Yapılandırma",
  "The versioned Equinox Local configuration loaded successfully.": "Sürümlenmiş Equinox Local yapılandırması başarıyla yüklendi.",
  "The managed workspace directory is available.": "Yönetilen çalışma alanı klasörü kullanılabilir.",
  "Development installation": "Geliştirme kurulumu",
  "This runtime is intentionally running from a source checkout; managed self-update is disabled.": "Bu runtime bilinçli olarak kaynak checkout'tan çalışıyor; yönetilen otomatik güncelleme devre dışı.",
  "Source checkout version": "Kaynak checkout sürümü",
  "Development tunnel runtime": "Geliştirme tunnel runtime'ı",
  "Development Peekaboo runtime": "Geliştirme Peekaboo runtime'ı",
  "The first-party Equinox Browser bridge is connected.": "Birinci taraf Equinox Browser köprüsü bağlı.",
  "Peekaboo desktop automation is available.": "Peekaboo masaüstü otomasyonu kullanılabilir.",
  "Access map": "Erişim haritası",
  "Manage": "Yönet",
  "Projects": "Projeler",
  "Folder roots": "Klasör kökleri",
  "Default project": "Varsayılan proje",
  "Only configured roots are exposed to Equinox Local tools. Paths stay in your private machine configuration.": "Equinox Local araçlarına yalnızca yapılandırılmış kökler açılır. Yollar özel makine yapılandırmanızda kalır.",
  "Agent file access follows your Agent Access mode. Configured roots remain convenient named shortcuts and stay in your private machine configuration.": "Ajan dosya erişimi Ajan Erişimi modunuzu izler. Yapılandırılmış kökler kullanışlı adlandırılmış kısayollar olarak kalır ve özel makine yapılandırmanızda tutulur.",
  "Runtime health": "Runtime sağlığı",
  "Checking recent runtime events": "Son runtime olayları kontrol ediliyor",
  "Checking": "Kontrol ediliyor",
  "The Control Center is asking the existing observability layer for a bounded health summary.": "Kontrol Merkezi mevcut gözlemlenebilirlik katmanından sınırlandırılmış bir sağlık özeti alıyor.",
  "— recent events": "— son olay",
  "Not evaluated yet": "Henüz değerlendirilmedi",
  "System doctor": "Sistem doktoru",
  "Checking setup": "Kurulum kontrol ediliyor",
  "Equinox Local is checking the runtime, private configuration, update path and optional integrations.": "Equinox Local runtime'ı, özel yapılandırmayı, güncelleme yolunu ve isteğe bağlı entegrasyonları kontrol ediyor.",
  "Not checked yet": "Henüz kontrol edilmedi",
  "Updates": "Güncellemeler",
  "Checking installation channel": "Kurulum kanalı kontrol ediliyor",
  "Managed installs can check the signed Equinox Local stable update channel without exposing local paths.": "Yönetilen kurulumlar yerel yolları açığa çıkarmadan imzalı Equinox Local kararlı güncelleme kanalını kontrol edebilir.",
  "Current version —": "Mevcut sürüm —",
  "Check for updates": "Güncellemeleri kontrol et",
  "Update & restart": "Güncelle ve yeniden başlat",
  "Access boundaries": "Erişim sınırları",
  "Add or update the roots Equinox Local is allowed to see. Changes are validated by the same configuration layer used by the agent runtime.": "Equinox Local'in görmesine izin verilen kökleri ekleyin veya güncelleyin. Değişiklikler ajan runtime'ının kullandığı aynı yapılandırma katmanında doğrulanır.",
  "Add read-only folder": "Salt okunur klasör ekle",
  "Add project": "Proje ekle",
  "Configured roots": "Yapılandırılmış kökler",
  "Loading…": "Yükleniyor…",
  "No unsaved changes": "Kaydedilmemiş değişiklik yok",
  "Unsaved changes": "Kaydedilmemiş değişiklikler",
  "Runtime routing": "Runtime yönlendirmesi",
  "Core folders": "Temel klasörler",
  "Used when an agent action does not name a project explicitly.": "Bir ajan eylemi açıkça proje belirtmediğinde kullanılır.",
  "Workspace project": "Çalışma alanı projesi",
  "Used for managed worktrees and runtime-owned workspace artifacts.": "Yönetilen worktree'ler ve runtime'a ait çalışma alanı artifact'ları için kullanılır.",
  "Downloads root": "İndirilenler kökü",
  "Must remain a read-only folder root.": "Salt okunur bir klasör kökü olarak kalmalıdır.",
  "Loopback binding is enforced by the backend and cannot be weakened here.": "Loopback bağlaması backend tarafından zorunlu tutulur ve buradan zayıflatılamaz.",
  "Save configuration": "Yapılandırmayı kaydet",
  "Saving…": "Kaydediliyor…",
  "Saving writes the validated config with a revision guard. A restart is required before further edits.": "Kaydetme işlemi doğrulanmış yapılandırmayı revision korumasıyla yazar. Daha fazla düzenleme için yeniden başlatma gerekir.",
  "User Chrome lane": "Kullanıcı Chrome hattı",
  "Equinox Browser is the first-party bridge for your normal Chrome and the only user-browser automation lane exposed by Equinox Local.": "Equinox Browser normal Chrome'unuz için birinci taraf köprüdür ve Equinox Local'in sunduğu tek kullanıcı-tarayıcı otomasyon hattıdır.",
  "Extension version": "Uzantı sürümü",
  "Connected since": "Bağlantı zamanı",
  "Connection model": "Bağlantı modeli",
  "Automation": "Otomasyon",
  "Browser controls": "Tarayıcı kontrolleri",
  "Local browser settings": "Yerel tarayıcı ayarları",
  "Browser automation": "Tarayıcı otomasyonu",
  "Turn agent control on or off while keeping the local settings channel available.": "Yerel ayar kanalını açık tutarken ajan kontrolünü açın veya kapatın.",
  "Agent cursor": "Ajan imleci",
  "Show the agent's click and hover target on the page.": "Ajanın tıklama ve hover hedefini sayfada gösterin.",
  "Agent display name": "Ajan görünen adı",
  "Shown beside the visible agent cursor. This setting stays in the extension's local storage.": "Görünür ajan imlecinin yanında gösterilir. Bu ayar uzantının yerel depolamasında kalır.",
  "Apply browser settings": "Tarayıcı ayarlarını uygula",
  "Applying…": "Uygulanıyor…",
  "Settings apply immediately and do not require a Local restart.": "Ayarlar hemen uygulanır ve Local'in yeniden başlatılmasını gerektirmez.",
  "Need Equinox Browser?": "Equinox Browser gerekli mi?",
  "Install or open the official unlisted Equinox Browser listing in Chrome Web Store.": "Resmi liste dışı Equinox Browser kaydını Chrome Web Store'dan yükleyin veya açın.",
  "Install Equinox Browser ↗": "Equinox Browser'ı yükle ↗",
  "Safe boundary": "Güvenli sınır",
  "No direct browser-debugging fallback": "Doğrudan browser-debugging fallback yok",
  "The user browser route stays on the Equinox Browser extension and Native Messaging bridge. Turning automation off detaches debugger sessions but does not create a hidden fallback route.": "Kullanıcı tarayıcı yolu Equinox Browser uzantısı ve Native Messaging köprüsünde kalır. Otomasyonu kapatmak debugger oturumlarını ayırır ancak gizli bir fallback yolu oluşturmaz.",
  "Agent access": "Ajan erişimi",
  "Equinox Local starts new installations with broad useful access. Narrow these controls when you want the agent contained to selected roots or without local execution.": "Equinox Local yeni kurulumları geniş ve kullanışlı erişimle başlatır. Ajanı seçili köklerle sınırlamak veya yerel çalıştırmayı kapatmak istediğinizde bu kontrolleri daraltın.",
  "Local capabilities": "Yerel yetenekler",
  "Agent Access": "Ajan Erişimi",
  "Files & projects": "Dosyalar ve projeler",
  "Full access": "Tam erişim",
  "Selected roots only": "Yalnızca seçili kökler",
  "Full access accepts configured project IDs, home, or an accessible absolute folder path. Known credential/application-secret areas are excluded from ad-hoc Full access, and the filesystem root remains blocked.": "Tam erişim yapılandırılmış proje kimliklerini, home kökünü veya erişilebilir mutlak klasör yollarını kabul eder. Bilinen kimlik bilgisi/uygulama gizli alanları ad-hoc Tam erişimin dışında tutulur ve dosya sistemi kökü engelli kalır.",
  "Terminal & processes": "Terminal ve süreçler",
  "Allow interactive shells and background processes with your normal macOS user permissions. Equinox Local never grants sudo or root by itself.": "Normal macOS kullanıcı izinlerinizle etkileşimli kabuklara ve arka plan süreçlerine izin verin. Equinox Local kendi başına sudo veya root yetkisi vermez.",
  "Desktop automation": "Masaüstü otomasyonu",
  "Allow the first-party desktop tool surface when macOS permissions are also granted.": "macOS izinleri de verilmişse birinci taraf masaüstü araç yüzeyine izin verin.",
  "Allow the Equinox Browser lane. Extension consent remains required and cannot be bypassed here.": "Equinox Browser hattına izin verin. Uzantı onayı gerekli kalır ve buradan atlanamaz.",
  "Save access settings": "Erişim ayarlarını kaydet",
  "Access changes use the validated configuration path and require a Local restart.": "Erişim değişiklikleri doğrulanmış yapılandırma yolunu kullanır ve Local'in yeniden başlatılmasını gerektirir.",
  "Maximum useful access": "Maksimum kullanışlı erişim",
  "Restricted access": "Sınırlı erişim",
  "Managed installation": "Yönetilen kurulum",
  "Uninstall Equinox Local": "Equinox Local'i kaldır",
  "Managed only": "Yalnızca yönetilen kurulum",
  "Remove the managed runtime, LaunchAgent, tunnel credentials and Equinox Browser Native Messaging host from this Mac. By default, your Equinox Workspace and Control Center configuration are preserved.": "Yönetilen runtime'ı, LaunchAgent'ı, tunnel kimlik bilgilerini ve Equinox Browser Native Messaging host'unu bu Mac'ten kaldırın. Varsayılan olarak Equinox Çalışma Alanınız ve Kontrol Merkezi yapılandırmanız korunur.",
  "Also delete local user data": "Yerel kullanıcı verilerini de sil",
  "This permanently removes the Equinox Workspace and saved Control Center configuration in addition to the managed runtime.": "Bu seçenek yönetilen runtime'a ek olarak Equinox Çalışma Alanını ve kaydedilmiş Kontrol Merkezi yapılandırmasını kalıcı olarak siler.",
  "Type": "Onay için",
  "to confirm": "yazın",
  "Workspace and configuration will be preserved unless the option above is enabled.": "Yukarıdaki seçenek etkinleştirilmedikçe çalışma alanı ve yapılandırma korunur.",
  "Uninstall scheduled. Equinox Local will stop and this page will disconnect.": "Kaldırma planlandı. Equinox Local duracak ve bu sayfanın bağlantısı kesilecek.",
  "Optional bridges fail independently. Core Equinox Local remains usable even when a browser or desktop integration is unavailable.": "İsteğe bağlı köprüler birbirinden bağımsız hata verir. Tarayıcı veya masaüstü entegrasyonu kullanılamasa bile temel Equinox Local kullanılabilir kalır.",
  "Diagnostics": "Tanılama",
  "This first Control Center slice shows bounded runtime and management-surface activity without exposing raw logs or arbitrary filesystem access.": "Kontrol Merkezi, ham logları veya sınırsız dosya sistemi erişimini açmadan sınırlandırılmış runtime ve yönetim yüzeyi etkinliğini gösterir.",
  "Control Center requests": "Kontrol Merkezi istekleri",
  "Since this runtime started": "Bu runtime başladığından beri",
  "Config mutations": "Yapılandırma değişiklikleri",
  "Accepted by this runtime": "Bu runtime tarafından kabul edildi",
  "Recent runtime events": "Son runtime olayları",
  "Health evaluation window": "Sağlık değerlendirme penceresi",
  "Audit timeline": "Denetim zaman çizelgesi",
  "Recent sanitized runtime activity": "Son temizlenmiş runtime etkinliği",
  "Last 6 hours · max 30": "Son 6 saat · en fazla 30",
  "Project": "Proje",
  "Close": "Kapat",
  "Identifier": "Kimlik",
  "Lowercase letters, numbers, dots, underscores and hyphens.": "Küçük harfler, sayılar, noktalar, alt çizgiler ve tireler.",
  "Display name": "Görünen ad",
  "Absolute folder path": "Mutlak klasör yolu",
  "Choose folder…": "Klasör seç…",
  "Choosing…": "Seçiliyor…",
  "Use the macOS folder picker or enter an absolute path manually. Equinox Local validates the selection and never grants the filesystem root.": "macOS klasör seçicisini kullanın veya mutlak yolu elle girin. Equinox Local seçimi doğrular ve dosya sisteminin kökünü hiçbir zaman açmaz.",
  "Managed worktrees": "Yönetilen worktree'ler",
  "Allow Equinox Local to create managed worktrees for this project.": "Equinox Local'in bu proje için yönetilen worktree'ler oluşturmasına izin verin.",
  "Read-only folder": "Salt okunur klasör",
  "V1 file roots are intentionally read-only and cannot be upgraded to writable from this screen.": "V1 dosya kökleri bilinçli olarak salt okunurdur ve bu ekrandan yazılabilir duruma yükseltilemez.",
  "Cancel": "İptal",
  "Apply to draft": "Taslağa uygula",
  "Ready": "Hazır",
  "Healthy": "Sağlıklı",
  "Needs attention": "Dikkat gerekli",
  "Attention": "Dikkat",
  "Action needed": "Eylem gerekli",
  "Connecting": "Bağlanıyor",
  "Restarting": "Yeniden başlatılıyor",
  "Connected, not ready": "Bağlı, hazır değil",
  "Disconnected": "Bağlantı kesildi",
  "Health unavailable": "Sağlık bilgisi kullanılamıyor",
  "Unknown": "Bilinmiyor",
  "Runtime healthy": "Runtime sağlıklı",
  "Connected · consent required": "Bağlı · onay gerekli",
  "Connected · automation off": "Bağlı · otomasyon kapalı",
  "Extension not connected": "Uzantı bağlı değil",
  "Unavailable": "Kullanılamıyor",
  "Extension version unavailable": "Uzantı sürümü kullanılamıyor",
  "Not available": "Kullanılamıyor",
  "Not checked": "Kontrol edilmedi",
  "Optional desktop capability": "İsteğe bağlı masaüstü yeteneği",
  "Listening": "Dinliyor",
  "Everything looks healthy": "Her şey sağlıklı görünüyor",
  "The bounded runtime health window has no unresolved warnings that need your attention.": "Sınırlandırılmış runtime sağlık penceresinde ilgilenmenizi gerektiren çözülmemiş bir uyarı yok.",
  "Runtime health is unavailable": "Runtime sağlık bilgisi kullanılamıyor",
  "The management API is reachable, but no runtime health summary was returned.": "Yönetim API'sine erişilebiliyor ancak runtime sağlık özeti dönmedi.",
  "Open the diagnostics tools for detail. The Control Center summary intentionally avoids exposing raw runtime logs.": "Ayrıntılar için tanılama araçlarını açın. Kontrol Merkezi özeti bilinçli olarak ham runtime loglarını göstermez.",
  "Your setup checks out": "Kurulumunuz sağlıklı",
  "A few setup checks need attention": "Bazı kurulum kontrolleri dikkat gerektiriyor",
  "Equinox Local checked the managed runtime, private configuration, update path and optional bridges without exposing local paths or secrets.": "Equinox Local yerel yolları veya gizli değerleri açığa çıkarmadan yönetilen runtime'ı, özel yapılandırmayı, güncelleme yolunu ve isteğe bağlı köprüleri kontrol etti.",
  "Review the checks below. Optional items do not block core Equinox Local, but attention items should be fixed before public-style use.": "Aşağıdaki kontrolleri inceleyin. İsteğe bağlı öğeler temel Equinox Local'i engellemez; dikkat gerektiren öğeler genel kullanımdan önce düzeltilmelidir.",
  "Check": "Kontrol",
  "No additional detail.": "Ek ayrıntı yok.",
  "Restart scheduled": "Yeniden başlatma planlandı",
  "Preparing": "Hazırlanıyor",
  "Source checkout": "Kaynak checkout",
  "This development checkout is never self-updated. Public shell-bootstrap installs use the managed signed update channel.": "Bu geliştirme checkout'u hiçbir zaman kendi kendini güncellemez. Genel shell-bootstrap kurulumları yönetilen imzalı güncelleme kanalını kullanır.",
  "Development": "Geliştirme",
  "Managed updates unavailable": "Yönetilen güncellemeler kullanılamıyor",
  "This installation is not eligible for managed self-update.": "Bu kurulum yönetilen otomatik güncelleme için uygun değil.",
  "Update channel not provisioned": "Güncelleme kanalı hazırlanmadı",
  "A trusted stable update signing key has not been provisioned in this build yet.": "Bu build'de henüz güvenilir bir kararlı güncelleme imza anahtarı tanımlanmadı.",
  "Not configured": "Yapılandırılmadı",
  "Update check needs attention": "Güncelleme kontrolü dikkat gerektiriyor",
  "Check failed": "Kontrol başarısız",
  "The signed stable release is verified. Update & restart prepares it in a separate release directory, switches atomically, verifies runtime health and rolls back automatically if activation fails.": "İmzalı kararlı sürüm doğrulandı. Güncelle ve yeniden başlat, sürümü ayrı bir release klasöründe hazırlar, atomik olarak geçirir, runtime sağlığını doğrular ve etkinleştirme başarısız olursa otomatik geri döner.",
  "Update available": "Güncelleme mevcut",
  "Equinox Local is up to date": "Equinox Local güncel",
  "The signed stable update channel reports no newer version.": "İmzalı kararlı güncelleme kanalı daha yeni bir sürüm olmadığını bildiriyor.",
  "Up to date": "Güncel",
  "Stable update channel ready": "Kararlı güncelleme kanalı hazır",
  "Check the signed stable manifest when you want to look for a newer Equinox Local release.": "Daha yeni bir Equinox Local sürümü aramak istediğinizde imzalı kararlı manifesti kontrol edin.",
  "Project boundary": "Proje sınırı",
  "Configured shortcut": "Yapılandırılmış kısayol",
  "Project tools stay contained to this configured root.": "Proje araçları bu yapılandırılmış kök içinde kalır.",
  "This configured project remains a convenient named shortcut. Full access can also address home or other accessible folders without pre-registering them.": "Bu yapılandırılmış proje kullanışlı bir adlandırılmış kısayol olarak kalır. Tam erişim ayrıca home veya diğer erişilebilir klasörlere önceden kayıt gerektirmeden ulaşabilir.",
  "Managed worktrees off": "Yönetilen worktree'ler kapalı",
  "Managed worktrees on": "Yönetilen worktree'ler açık",
  "Default": "Varsayılan",
  "Workspace": "Çalışma alanı",
  "Downloads root": "İndirilenler kökü",
  "Edit": "Düzenle",
  "Remove": "Kaldır",
  "Change the runtime routing first before removing this root.": "Bu kökü kaldırmadan önce runtime yönlendirmesini değiştirin.",
  "Remove from the draft configuration": "Taslak yapılandırmadan kaldır",
  "Read only": "Salt okunur",
  "Project tools stay contained to this configured root. Granular per-tool capability switches are not part of config schema V1 yet.": "Proje araçları bu yapılandırılmış kök içinde kalır. Araç başına ayrıntılı yetenek anahtarları henüz V1 yapılandırma şemasının parçası değildir.",
  "This extra file root is intentionally read-only in V1 and cannot be promoted to writable from the Control Center.": "Bu ek dosya kökü V1'de bilinçli olarak salt okunurdur ve Kontrol Merkezi'nden yazılabilir duruma yükseltilemez.",
  "Stopping": "Durduruluyor",
  "Deletes user data": "Kullanıcı verilerini siler",
  "Preserves user data": "Kullanıcı verilerini korur",
  "Uninstall scheduled": "Kaldırma planlandı",
  "Scheduling uninstall…": "Kaldırma planlanıyor…",
  "Uninstall & delete local data": "Kaldır ve yerel verileri sil",
  "Telegram": "Telegram",
  "Saved Telegram credentials need attention. Reconnect the bot to replace them safely.": "Kaydedilmiş Telegram kimlik bilgileri dikkat gerektiriyor. Güvenle değiştirmek için botu yeniden bağlayın.",
  "Connect a Telegram bot to one Telegram account. Groups and channels are not supported, and agents cannot choose another recipient.": "Bir Telegram botunu tek bir Telegram hesabına bağlayın. Gruplar ve kanallar desteklenmez; ajanlar başka bir alıcı seçemez.",
  "Send test": "Test gönder",
  "Disconnect": "Bağlantıyı kes",
  "Bot token": "Bot tokenı",
  "Your Telegram ID": "Telegram ID'niz",
  "Connect & test": "Bağlan ve test et",
  "Consent required": "Onay gerekli",
  "Automation off": "Otomasyon kapalı",
  "Browser settings": "Tarayıcı ayarları",
  "Install extension": "Uzantıyı yükle",
  "Chrome Web Store": "Chrome Web Store",
  "Peekaboo desktop bridge": "Peekaboo masaüstü köprüsü",
  "First-party Chrome bridge through the extension and Native Messaging.": "Uzantı ve Native Messaging üzerinden birinci taraf Chrome köprüsü.",
  "Optional macOS desktop capability. It is not required for core Equinox Local filesystem or Git operations.": "İsteğe bağlı macOS masaüstü yeteneği. Temel Equinox Local dosya sistemi veya Git işlemleri için gerekli değildir.",
  "Allowed": "İzin verildi",
  "Off": "Kapalı",
  "Open the Equinox Browser popup, review the data-use disclosure, and enable browser control there. The local settings channel remains connected.": "Equinox Browser popup'ını açın, veri kullanımı açıklamasını inceleyin ve tarayıcı kontrolünü oradan etkinleştirin. Yerel ayar kanalı bağlı kalır.",
  "Settings apply immediately through Native Messaging and do not require an Equinox Local restart.": "Ayarlar Native Messaging üzerinden hemen uygulanır ve Equinox Local'in yeniden başlatılmasını gerektirmez.",
  "Connect Equinox Browser to manage these settings from Control Center.": "Bu ayarları Kontrol Merkezi'nden yönetmek için Equinox Browser'ı bağlayın.",
  "No sanitized runtime events were recorded in the last six hours.": "Son altı saatte temizlenmiş bir runtime olayı kaydedilmedi.",
  "Runtime event": "Runtime olayı",
  "Edit project": "Projeyi düzenle",
  "Add read-only folder": "Salt okunur klasör ekle",
  "Edit read-only folder": "Salt okunur klasörü düzenle",
  "Identifier must use lowercase letters, numbers, dots, underscores or hyphens.": "Kimlik küçük harfler, sayılar, noktalar, alt çizgiler veya tireler kullanmalıdır.",
  "Display name must be 1-100 characters.": "Görünen ad 1-100 karakter olmalıdır.",
  "Folder path must be absolute and start with /.": "Klasör yolu mutlak olmalı ve / ile başlamalıdır.",
  "The filesystem root itself cannot be granted.": "Dosya sisteminin kökü doğrudan verilemez.",
  "Folder path is too long.": "Klasör yolu çok uzun.",
  "That identifier is already in use by another configured root.": "Bu kimlik başka bir yapılandırılmış kök tarafından zaten kullanılıyor.",
  "That folder path is already configured under another root.": "Bu klasör yolu başka bir kök altında zaten yapılandırılmış.",
  "Draft updated. Save when you are ready.": "Taslak güncellendi. Hazır olduğunuzda kaydedin.",
  "Folder selection cancelled.": "Klasör seçimi iptal edildi.",
  "Browser settings updated.": "Tarayıcı ayarları güncellendi.",
  "Telegram connected and test message sent.": "Telegram bağlandı ve test mesajı gönderildi.",
  "Telegram test message sent.": "Telegram test mesajı gönderildi.",
  "Telegram disconnected.": "Telegram bağlantısı kesildi.",
  "Equinox Local is connected to ChatGPT.": "Equinox Local ChatGPT'ye bağlı.",
  "Tunnel settings saved. Equinox Local is restarting safely…": "Tunnel ayarları kaydedildi. Equinox Local güvenli biçimde yeniden başlatılıyor…",
  "Equinox Local is restarting safely…": "Equinox Local güvenli biçimde yeniden başlatılıyor…",
  "Configuration saved safely.": "Yapılandırma güvenle kaydedildi.",
  "Saved · restart required": "Kaydedildi · yeniden başlatma gerekli",
  "HEALTHY": "SAĞLIKLI",
  "DEGRADED": "BOZULMUŞ",
  "RECOVERING": "TOPARLANIYOR",
  "ATTENTION REQUIRED": "DİKKAT GEREKLİ",
  "ATTENTION": "DİKKAT",
});

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.has(value) ? value : "en";
}

function initialLanguage() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.has(stored)) return stored;
  } catch {
    // A blocked localStorage must not prevent Control Center from loading.
  }
  return String(navigator.language || "").toLowerCase().startsWith("tr") ? "tr" : "en";
}

function localeForLanguage(language) {
  return language === "tr" ? "tr-TR" : "en-US";
}

const state = {
  language: initialLanguage(),
  activeSection: "dashboard",
  lastRefreshedAt: null,
  config: null,
  revision: null,
  status: null,
  health: null,
  doctor: null,
  activity: [],
  update: null,
  updateBusy: false,
  updateApplyBusy: false,
  onboarding: null,
  onboardingBusy: false,
  onboardingReconnectTimer: null,
  uninstallBusy: false,
  uninstallScheduled: false,
  telegram: null,
  telegramBotToken: "",
  telegramUserId: "",
  browserDraft: null,
  browserSettingsDirty: false,
  browserSettingsBusy: false,
  integrationBusy: false,
  pickerBusy: false,
  restartBusy: false,
  runtimeRestartTimer: null,
  dirty: false,
  restartRequired: false,
  dialogMode: null,
  dialogKind: "project",
  editingId: null,
  toastTimer: null,
};

function localizeUiText(value) {
  const source = String(value ?? "");
  if (state.language !== "tr" || !source) return source;
  const exact = TR_UI[source];
  if (exact) return exact;

  let match = source.match(/^(\d+)d (\d+)h uptime$/u);
  if (match) return `${match[1]}g ${match[2]}sa çalışma süresi`;
  match = source.match(/^(\d+)h (\d+)m uptime$/u);
  if (match) return `${match[1]}sa ${match[2]}dk çalışma süresi`;
  match = source.match(/^(\d+)m uptime$/u);
  if (match) return `${match[1]}dk çalışma süresi`;
  match = source.match(/^(\d+) recent events$/u);
  if (match) return `${match[1]} son olay`;
  match = source.match(/^Evaluated (.+)$/u);
  if (match) return `Değerlendirildi: ${match[1]}`;
  match = source.match(/^Checked (.+)$/u);
  if (match) return `Kontrol edildi: ${match[1]}`;
  match = source.match(/^Refreshed (.+)$/u);
  if (match) return `Yenilendi: ${match[1]}`;
  match = source.match(/^Current version (.+)$/u);
  if (match) return `Mevcut sürüm ${match[1]}`;
  match = source.match(/^(\d+) projects · (\d+) read-only folders?$/u);
  if (match) return `${match[1]} proje · ${match[2]} salt okunur klasör`;
  match = source.match(/^Restarting into Equinox Local (.+)$/u);
  if (match) return `Equinox Local ${match[1]} sürümüne yeniden başlatılıyor`;
  match = source.match(/^Preparing Equinox Local (.+)$/u);
  if (match) return `Equinox Local ${match[1]} hazırlanıyor`;
  match = source.match(/^Equinox Local (.+) is available$/u);
  if (match) return `Equinox Local ${match[1]} kullanılabilir`;
  match = source.match(/^Equinox Local (.+) is prepared\. Restarting safely…$/u);
  if (match) return `Equinox Local ${match[1]} hazırlandı. Güvenli biçimde yeniden başlatılıyor…`;
  match = source.match(/^First-party Chrome bridge · extension (.+)\.$/u);
  if (match) return `Birinci taraf Chrome köprüsü · uzantı ${match[1]}.`;
  match = source.match(/^Optional macOS desktop capability · Peekaboo (.+)\.$/u);
  if (match) return `İsteğe bağlı macOS masaüstü yeteneği · Peekaboo ${match[1]}.`;
  match = source.match(/^Extension (.+)$/u);
  if (match) return `Uzantı ${match[1]}`;
  match = source.match(/^Equinox Local (.+) and reports healthy\.$/u);
  if (match) return `Equinox Local ${match[1]} çalışıyor ve sağlıklı.`;
  match = source.match(/^Running process matches source checkout version (.+)\.$/u);
  if (match) return `Çalışan süreç kaynak checkout sürümü ${match[1]} ile eşleşiyor.`;
  match = source.match(/^Development tunnel-client (.+) matches the pinned runtime version\.$/u);
  if (match) return `Geliştirme tunnel-client ${match[1]}, pinlenmiş runtime sürümüyle eşleşiyor.`;
  match = source.match(/^Development Peekaboo (.+) matches the pinned desktop runtime version\.$/u);
  if (match) return `Geliştirme Peekaboo ${match[1]}, pinlenmiş masaüstü runtime sürümüyle eşleşiyor.`;
  match = source.match(/^Managed release (.+) passed layout and runtime validation\.$/u);
  if (match) return `Yönetilen ${match[1]} sürümü yerleşim ve runtime doğrulamasını geçti.`;
  match = source.match(/^Equinox Local is source version (.+), but the running process is (.+)\.$/u);
  if (match) return `Equinox Local kaynak sürümü ${match[1]}, çalışan süreç ise ${match[2]}.`;
  match = source.match(/^(\d+) passed · (\d+) attention · (\d+) optional$/u);
  if (match) return `${match[1]} geçti · ${match[2]} dikkat · ${match[3]} isteğe bağlı`;
  match = source.match(/^Bot API is connected(?: to user (.+))?\. Agents can send messages only to this Telegram account; the recipient cannot be changed by an agent\.$/u);
  if (match) {
    const user = match[1] ? ` ${match[1]} kullanıcısına` : "";
    return `Bot API${user} bağlı. Ajanlar yalnızca bu Telegram hesabına mesaj gönderebilir; alıcı bir ajan tarafından değiştirilemez.`;
  }
  return source;
}

const DYNAMIC_TEXT_IDS = new Set([
  "sidebar-health-label", "sidebar-version", "section-kicker", "section-title", "last-refreshed",
  "restart-runtime-button", "onboarding-copy", "onboarding-badge", "setup-runtime-status",
  "setup-workspace-status", "setup-browser-status", "setup-tunnel-status", "onboarding-connect-button",
  "runtime-health-badge", "runtime-version", "runtime-uptime", "browser-status", "browser-version",
  "peekaboo-status", "peekaboo-detail", "api-status", "api-detail", "project-count", "folder-count",
  "default-project", "health-summary-title", "health-summary-badge", "health-summary-copy", "health-event-count",
  "health-evaluated-at", "doctor-title", "doctor-badge", "doctor-copy", "doctor-list", "doctor-summary",
  "doctor-checked-at", "update-title", "update-badge", "update-copy", "update-version", "update-checked-at",
  "check-update-button", "install-update-button", "root-count-label", "dirty-state", "project-list",
  "default-project-select", "workspace-project-select", "downloads-root-select", "control-center-address",
  "save-config-button", "browser-page-status", "browser-page-badge", "browser-page-version", "browser-connected-at",
  "browser-control-state", "apply-browser-settings", "browser-settings-note", "permissions-list", "agent-access-badge",
  "save-agent-access-button", "uninstall-badge",
  "uninstall-confirmation-help", "uninstall-button", "integration-list", "request-count", "mutation-count",
  "activity-event-count", "activity-timeline", "dialog-kicker", "dialog-title", "dialog-error", "choose-folder-button",
  "error-message", "toast",
]);

const staticTextEntries = [];
const staticAttributeEntries = [];

function captureStaticTranslatables() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const source = node.nodeValue || "";
    if (!source.trim()) continue;
    const owner = node.parentElement?.closest?.("[id]");
    if (owner && DYNAMIC_TEXT_IDS.has(owner.id)) continue;
    staticTextEntries.push({ node, source });
  }
  for (const element of document.querySelectorAll("[placeholder], [aria-label], [title]")) {
    for (const attribute of ["placeholder", "aria-label", "title"]) {
      const source = element.getAttribute(attribute);
      if (source) staticAttributeEntries.push({ element, attribute, source });
    }
  }
}

function applyStaticLanguage() {
  document.documentElement.lang = state.language;
  document.title = localizeUiText("Equinox Local Control Center");
  for (const entry of staticTextEntries) {
    const leading = entry.source.match(/^\s*/u)?.[0] || "";
    const trailing = entry.source.match(/\s*$/u)?.[0] || "";
    entry.node.nodeValue = `${leading}${localizeUiText(entry.source.trim())}${trailing}`;
  }
  for (const entry of staticAttributeEntries) {
    entry.element.setAttribute(entry.attribute, localizeUiText(entry.source));
  }
  const select = $("language-select");
  if (select) select.value = state.language;
}

function renderLastRefreshed() {
  setText(
    "last-refreshed",
    state.lastRefreshedAt
      ? `Refreshed ${new Intl.DateTimeFormat(localeForLanguage(state.language), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(state.lastRefreshedAt)}`
      : "Not refreshed yet",
  );
}

function localizeDoctorDetail(item) {
  const detail = String(item?.detail || "No additional detail.");
  return localizeUiText(detail);
}

function legacyEventMessageToEnglish(message) {
  const source = String(message || "");
  const exact = new Map([
    ["PTY terminal buffer sınırını aştı; eski çıktı düşürülüyor.", "PTY terminal output buffer exceeded its limit; older output is being dropped."],
    ["PTY terminal oturumu başlatıldı.", "PTY terminal session started."],
    ["PTY terminal oturumu beklenmedik biçimde sonlandı.", "PTY terminal session ended unexpectedly."],
    ["PTY terminal oturumu sonlandı.", "PTY terminal session ended."],
    ["PTY terminal oturumu için durdurma istendi.", "Stop requested for PTY terminal session."],
    ["Yönetilen süreç log buffer sınırını aştı; eski çıktı düşürülüyor.", "Managed process log buffer exceeded its limit; older output is being dropped."],
    ["Yönetilen arka plan süreci başlatıldı.", "Managed background process started."],
    ["Yönetilen arka plan süreci beklenmedik biçimde sonlandı.", "Managed background process ended unexpectedly."],
    ["Yönetilen arka plan süreci sonlandı.", "Managed background process ended."],
    ["Yönetilen arka plan süreci için durdurma istendi.", "Stop requested for managed background process."],
    ["Workflow başarıyla tamamlandı.", "Workflow completed successfully."],
    ["Workflow devam ettirme isteği alındı.", "Workflow resume requested."],
    ["Peekaboo MCP alt süreci beklenmedik biçimde kapandı.", "Peekaboo MCP child process closed unexpectedly."],
    ["Peekaboo MCP köprüsü bağlandı.", "Peekaboo MCP bridge connected."],
    ["Peekaboo MCP transport bağlantısı yeniden kuruldu.", "Peekaboo MCP transport connection recovered."],
    ["Peekaboo güvenli araç yüzeyi uyumluluk kontrolünü geçti.", "Peekaboo safe tool-surface compatibility check passed."],
    ["Equinox Local macOS izinlerinden en az biri kullanılamıyor.", "At least one required Equinox Local macOS permission is unavailable."],
    ["Equinox Local Screen Recording ve Accessibility izinleri hazır.", "Equinox Local Screen Recording and Accessibility permissions are ready."],
    ["Peekaboo bridge restart başladı.", "Peekaboo bridge restart started."],
    ["Chrome bridge restart başladı.", "Chrome bridge restart started."],
    ["Stale preview sahipliği listener PID + managed PID + terminal workflow ile doğrulandı.", "Stale preview ownership was verified by listener PID, managed PID, and terminal workflow."],
    ["Orphan workflow child süreç sahipliği doğrulandı.", "Orphan workflow child-process ownership was verified."],
    ["Workflow resumable state ve child-process temizliği doğrulandı; project root guard yeniden çalıştırılacak.", "Workflow resumable state and child-process cleanup were verified; the project-root guard will run again."],
    ["Equinox Local runtime kapanışı başladı.", "Equinox Local runtime shutdown started."],
    ["Equinox Local runtime kaynakları temiz biçimde kapatıldı.", "Equinox Local runtime resources shut down cleanly."],
  ]);
  if (exact.has(source)) return exact.get(source);
  let match = source.match(/^Equinox Local (.+) runtime başladı\.$/u);
  if (match) return `Equinox Local ${match[1]} runtime started.`;
  match = source.match(/^Workflow başladı: (.+)$/u);
  if (match) return `Workflow started: ${match[1]}`;
  match = source.match(/^Repair başladı: (.+)$/u);
  if (match) return `Repair started: ${match[1]}`;
  match = source.match(/^Janitor cleanup başladı: (.+)$/u);
  if (match) return `Janitor cleanup started: ${match[1]}`;
  match = source.match(/^Janitor cleanup tamamlandı: (.+) \((\d+) öğe\)\.$/u);
  if (match) return `Janitor cleanup completed: ${match[1]} (${match[2]} items).`;
  match = source.match(/^Runtime janitor bakım turu başladı: (.+)$/u);
  if (match) return `Runtime janitor maintenance cycle started: ${match[1]}`;
  match = source.match(/^Runtime janitor bakım turu tamamlandı; (\d+) öğe temizlendi\.$/u);
  if (match) return `Runtime janitor maintenance cycle completed; ${match[1]} items cleaned.`;
  match = source.match(/^Automatic recovery circuit açık: (.+)$/u);
  if (match) return `Automatic recovery circuit is open: ${match[1]}`;
  match = source.match(/^Automatic recovery circuit yeniden tek denemeye açıldı: (.+)$/u);
  if (match) return `Automatic recovery circuit reopened for a single trial: ${match[1]}`;
  match = source.match(/^Automatic recovery askıya alındı: (.+)$/u);
  if (match) return `Automatic recovery was suspended: ${match[1]}`;
  match = source.match(/^Aynı automatic recovery işi zaten aktif: (.+)$/u);
  if (match) return `The same automatic recovery job is already active: ${match[1]}`;
  match = source.match(/^Automatic recovery başladı: (.+)$/u);
  if (match) return `Automatic recovery started: ${match[1]}`;
  match = source.match(/^Automatic recovery tamamlanamadı: (.+)$/u);
  if (match) return `Automatic recovery did not complete: ${match[1]}`;
  match = source.match(/^Automatic recovery başarıyla tamamlandı: (.+)$/u);
  if (match) return `Automatic recovery completed successfully: ${match[1]}`;
  match = source.match(/^Automatic recovery trigger sonrası aktif incident bulunamadı: (.+)$/u);
  if (match) return `No active incident remained after the automatic recovery trigger: ${match[1]}`;
  match = source.match(/^Startup automatic recovery reconciliation tamamlandı: (\d+) incident işlendi\.$/u);
  if (match) return `Startup automatic recovery reconciliation completed: ${match[1]} incidents processed.`;
  match = source.match(/^Janitor preview değişti; (.+) cleanup reddedildi\.$/u);
  if (match) return `Janitor preview changed; cleanup was refused for ${match[1]}.`;
  match = source.match(/^Janitor cleanup tamamlanamadı: (.+)$/u);
  if (match) return `Janitor cleanup did not complete: ${match[1]}`;
  match = source.match(/^Runtime janitor bakım turu kısmi tamamlandı; (\d+) kategori başarısız\.$/u);
  if (match) return `Runtime janitor maintenance cycle completed partially; ${match[1]} categories failed.`;
  return source;
}

function localizeRuntimeEventMessage(message) {
  const english = legacyEventMessageToEnglish(message);
  if (state.language !== "tr") return english;
  const exact = {
    "PTY terminal output buffer exceeded its limit; older output is being dropped.": "PTY terminal çıktı buffer'ı sınırı aştı; eski çıktı düşürülüyor.",
    "PTY terminal session started.": "PTY terminal oturumu başlatıldı.",
    "PTY terminal session ended unexpectedly.": "PTY terminal oturumu beklenmedik biçimde sonlandı.",
    "PTY terminal session ended.": "PTY terminal oturumu sonlandı.",
    "Stop requested for PTY terminal session.": "PTY terminal oturumu için durdurma istendi.",
    "Managed process log buffer exceeded its limit; older output is being dropped.": "Yönetilen süreç log buffer'ı sınırı aştı; eski çıktı düşürülüyor.",
    "Managed background process started.": "Yönetilen arka plan süreci başlatıldı.",
    "Managed background process ended unexpectedly.": "Yönetilen arka plan süreci beklenmedik biçimde sonlandı.",
    "Managed background process ended.": "Yönetilen arka plan süreci sonlandı.",
    "Stop requested for managed background process.": "Yönetilen arka plan süreci için durdurma istendi.",
    "Workflow completed successfully.": "Workflow başarıyla tamamlandı.",
    "Workflow resume requested.": "Workflow devam ettirme isteği alındı.",
    "Workflow was cancelled.": "Workflow iptal edildi.",
    "Workflow cancellation requested.": "Workflow iptal isteği alındı.",
    "Workflow was safely paused for runtime shutdown.": "Workflow runtime kapanışı için güvenli biçimde duraklatıldı.",
    "Peekaboo MCP child process closed unexpectedly.": "Peekaboo MCP alt süreci beklenmedik biçimde kapandı.",
    "Peekaboo MCP bridge connected.": "Peekaboo MCP köprüsü bağlandı.",
    "Peekaboo MCP transport connection recovered.": "Peekaboo MCP transport bağlantısı yeniden kuruldu.",
    "Peekaboo safe tool-surface compatibility check passed.": "Peekaboo güvenli araç yüzeyi uyumluluk kontrolünü geçti.",
    "At least one required Equinox Local macOS permission is unavailable.": "Gerekli Equinox Local macOS izinlerinden en az biri kullanılamıyor.",
    "Equinox Local Screen Recording and Accessibility permissions are ready.": "Equinox Local Screen Recording ve Accessibility izinleri hazır.",
    "Peekaboo bridge restart started.": "Peekaboo bridge yeniden başlatması başladı.",
    "Chrome bridge restart started.": "Chrome bridge yeniden başlatması başladı.",
    "Stale preview ownership was verified by listener PID, managed PID, and terminal workflow.": "Stale preview sahipliği listener PID, managed PID ve terminal workflow ile doğrulandı.",
    "Orphan workflow child-process ownership was verified.": "Orphan workflow child süreç sahipliği doğrulandı.",
    "Workflow resumable state and child-process cleanup were verified; the project-root guard will run again.": "Workflow devam ettirilebilir durumu ve child-process temizliği doğrulandı; project-root guard yeniden çalıştırılacak.",
    "The incident already appeared resolved at repair time; no mutation was performed.": "Incident repair anında zaten çözülmüş görünüyordu; mutasyon yapılmadı.",
    "Peekaboo restart backend is unavailable.": "Peekaboo restart backend kullanılamıyor.",
    "Peekaboo bridge restarted, but compatibility, permission, or server-health verification did not fully pass.": "Peekaboo bridge yeniden başlatıldı ancak uyumluluk, izin veya server-health doğrulaması tam geçmedi.",
    "Peekaboo bridge restarted and compatibility, macOS permissions, and server status were verified.": "Peekaboo bridge yeniden başlatıldı; uyumluluk, macOS izinleri ve server status doğrulandı.",
    "Chrome bridge restart backend is unavailable.": "Chrome bridge restart backend kullanılamıyor.",
    "Chrome bridge restart completed, but the real Chrome backend did not reach ACTIVE readiness.": "Chrome bridge yeniden başlatıldı ancak gerçek Chrome backend ACTIVE hazır durumuna ulaşmadı.",
    "Chrome DevTools MCP bridge reconnected and real Chrome backend readiness was verified.": "Chrome DevTools MCP bridge yeniden bağlandı ve gerçek Chrome backend hazır durumu doğrulandı.",
    "Preview incident has no valid port evidence; cleanup was not performed.": "Preview incident geçerli port kanıtı taşımıyor; cleanup yapılmadı.",
    "The preview process was left untouched because lsof listener ownership could not be verified.": "lsof listener sahipliği doğrulanamadığı için preview sürecine dokunulmadı.",
    "Preview cleanup requires an exact one-to-one match between a single listener PID and a single managed workflow preview PID; the condition was not met.": "Preview cleanup için tek listener PID ile tek yönetilen workflow preview PID birebir eşleşmeli; koşul sağlanmadı.",
    "No workflow record was found for the incident; child-process ownership could not be proven.": "Incident için workflow kaydı bulunamadı; child-process sahipliği kanıtlanamadı.",
    "Workflow is still active; child-process cleanup was refused for safety.": "Workflow hâlâ aktif; child-process cleanup güvenlik nedeniyle reddedildi.",
    "Some workflow child processes are still running after cleanup.": "Bazı workflow child süreçleri cleanup sonrasında hâlâ çalışıyor.",
    "No workflow record was found for resume.": "Resume için workflow kaydı bulunamadı.",
    "Safe workflow resume backend is unavailable.": "Güvenli workflow resume backend kullanılamıyor.",
    "Workflow resume was accepted, but the workflow immediately returned to failed state.": "Workflow resume kabul edildi ancak workflow hemen yeniden failed durumuna geçti.",
    "GitHub deployment workflow was dispatched.": "GitHub deployment workflow'u dispatch edildi.",
    "Direct deployment process started.": "Doğrudan deployment süreci başlatıldı.",
    "Direct deployment completed successfully.": "Doğrudan deployment başarıyla tamamlandı.",
    "Direct deployment process failed.": "Doğrudan deployment süreci başarısız oldu.",
    "Isolated managed Chrome instance launched for Selene.": "Selene için izole yönetilen Chrome instance'ı başlatıldı.",
    "Equinox Local runtime shutdown started.": "Equinox Local runtime kapanışı başladı.",
    "Equinox Local runtime resources shut down cleanly.": "Equinox Local runtime kaynakları temiz biçimde kapatıldı.",
  };
  if (exact[english]) return exact[english];

  let match = english.match(/^Equinox Local (.+) runtime started\.$/u);
  if (match) return `Equinox Local ${match[1]} runtime başladı.`;
  match = english.match(/^Workflow started: (.+)$/u);
  if (match) return `Workflow başladı: ${match[1]}`;
  match = english.match(/^Repair started: (.+)$/u);
  if (match) return `Repair başladı: ${match[1]}`;
  match = english.match(/^Repair could not be executed: (.+)$/u);
  if (match) return `Repair yürütülemedi: ${match[1]}`;
  match = english.match(/^Recipe (.+) does not apply to incident code (.+); no mutation was performed\.$/u);
  if (match) return `${match[1]} tarifi ${match[2]} incident koduna uygulanamaz; mutasyon yapılmadı.`;
  match = english.match(/^Managed preview process stopped, but port (\d+) is still listening; another listener may exist\.$/u);
  if (match) return `Yönetilen preview süreci durduruldu ancak ${match[1]} portu hâlâ dinleniyor; başka listener olabilir.`;
  match = english.match(/^Stale managed preview process was stopped safely and port (\d+) was verified free\.$/u);
  if (match) return `Stale yönetilen preview süreci güvenli biçimde kapatıldı ve ${match[1]} portunun boş olduğu doğrulandı.`;
  match = english.match(/^(\d+) orphan managed workflow child processes were stopped safely\.$/u);
  if (match) return `${match[1]} orphan yönetilen workflow child süreci güvenli biçimde kapatıldı.`;
  match = english.match(/^Workflow is not in a safe resume state: (.+)\.$/u);
  if (match) return `Workflow güvenli resume durumunda değil: ${match[1]}.`;
  match = english.match(/^A managed child process is still running before workflow resume; orphan_process_cleanup must run first\.$/u);
  if (match) return "Workflow resume öncesinde hâlâ çalışan yönetilen child süreç var; önce orphan_process_cleanup çalıştırılmalı.";
  match = english.match(/^Workflow entered an unexpected state after resume: (.+)\.$/u);
  if (match) return `Workflow resume sonrasında beklenmeyen durumda: ${match[1]}.`;
  match = english.match(/^Release preview port is now free: (\d+)\.$/u);
  if (match) return `Release preview portu artık boş: ${match[1]}.`;
  match = english.match(/^Release preview port was freed by self-healing: (\d+)\.$/u);
  if (match) return `Release preview portu self-healing ile boşaltıldı: ${match[1]}.`;

  match = english.match(/^Janitor preview changed; cleanup was refused for (.+)\.$/u);
  if (match) return `Janitor preview değişti; ${match[1]} cleanup reddedildi.`;
  match = english.match(/^Janitor cleanup started: (.+)$/u);
  if (match) return `Janitor cleanup başladı: ${match[1]}`;
  match = english.match(/^Janitor cleanup completed: (.+) \((\d+) items\)\.$/u);
  if (match) return `Janitor cleanup tamamlandı: ${match[1]} (${match[2]} öğe).`;
  match = english.match(/^Janitor cleanup did not complete: (.+)$/u);
  if (match) return `Janitor cleanup tamamlanamadı: ${match[1]}`;
  match = english.match(/^Runtime janitor maintenance cycle started: (.+)$/u);
  if (match) return `Runtime janitor bakım turu başladı: ${match[1]}`;
  match = english.match(/^Runtime janitor maintenance cycle completed partially; (\d+) categories failed\.$/u);
  if (match) return `Runtime janitor bakım turu kısmi tamamlandı; ${match[1]} kategori başarısız.`;
  match = english.match(/^Runtime janitor maintenance cycle completed; (\d+) items cleaned\.$/u);
  if (match) return `Runtime janitor bakım turu tamamlandı; ${match[1]} öğe temizlendi.`;

  match = english.match(/^Automatic recovery circuit is open: (.+)$/u);
  if (match) return `Automatic recovery circuit açık: ${match[1]}`;
  match = english.match(/^Automatic recovery circuit reopened for a single trial: (.+)$/u);
  if (match) return `Automatic recovery circuit tek deneme için yeniden açıldı: ${match[1]}`;
  match = english.match(/^Automatic recovery was suspended: (.+)$/u);
  if (match) return `Automatic recovery askıya alındı: ${match[1]}`;
  match = english.match(/^The same automatic recovery job is already active: (.+)$/u);
  if (match) return `Aynı automatic recovery işi zaten aktif: ${match[1]}`;
  match = english.match(/^Automatic recovery started: (.+)$/u);
  if (match) return `Automatic recovery başladı: ${match[1]}`;
  match = english.match(/^Automatic recovery did not complete: (.+)$/u);
  if (match) return `Automatic recovery tamamlanamadı: ${match[1]}`;
  match = english.match(/^Automatic recovery completed successfully: (.+)$/u);
  if (match) return `Automatic recovery başarıyla tamamlandı: ${match[1]}`;
  match = english.match(/^No active incident remained after the automatic recovery trigger: (.+)$/u);
  if (match) return `Automatic recovery tetiklemesinden sonra aktif incident kalmadı: ${match[1]}`;
  match = english.match(/^Startup automatic recovery reconciliation completed: (\d+) incidents processed\.$/u);
  if (match) return `Başlangıç automatic recovery reconciliation tamamlandı: ${match[1]} incident işlendi.`;

  match = english.match(/^Peekaboo compatibility check failed: (.+)$/u);
  if (match) return `Peekaboo uyumluluk kontrolü başarısız: ${match[1]}`;
  match = english.match(/^Chrome DevTools MCP bridge closed: (.+)$/u);
  if (match) return `Chrome DevTools MCP köprüsü kapatıldı: ${match[1]}`;
  match = english.match(/^Chrome DevTools MCP bridge closed unexpectedly: (.+)$/u);
  if (match) return `Chrome DevTools MCP köprüsü beklenmedik biçimde kapandı: ${match[1]}`;
  match = english.match(/^Internal Chrome DevTools connection attempt started: (.+)$/u);
  if (match) return `Internal Chrome DevTools bağlantı denemesi başladı: ${match[1]}`;
  match = english.match(/^Internal Chrome DevTools MCP bridge and backend are ready: (.+)$/u);
  if (match) return `Internal Chrome DevTools MCP köprüsü ve backend hazır: ${match[1]}`;
  match = english.match(/^Stale Chrome bridge detected and will reconnect: (.+)$/u);
  if (match) return `Stale Chrome bridge algılandı ve yeniden bağlanacak: ${match[1]}`;
  match = english.match(/^Stale Chrome bridge reconnected: (.+)$/u);
  if (match) return `Stale Chrome bridge yeniden bağlandı: ${match[1]}`;
  match = english.match(/^Deployment requested: (.+)$/u);
  if (match) return `Deployment istendi: ${match[1]}`;

  return localizeUiText(english);
}

function setLanguage(nextLanguage, { persist = true } = {}) {
  const language = normalizeLanguage(nextLanguage);
  state.language = language;
  if (persist) {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Language selection still applies for the current page if storage is unavailable.
    }
  }
  applyStaticLanguage();
  if (state.config) renderAll();
  setText("save-config-button", "Save configuration");
  switchSection(state.activeSection);
  renderLastRefreshed();
  if (state.dialogMode) {
    const isProject = state.dialogKind === "project";
    const isEdit = state.dialogMode === "edit";
    setText("dialog-kicker", isProject ? "Project" : "Read-only folder");
    setText("dialog-title", `${isEdit ? "Edit" : "Add"} ${isProject ? "project" : "read-only folder"}`);
  }
}

const sectionMeta = {
  dashboard: ["Overview", "Dashboard"],
  projects: ["Access boundaries", "Projects & folders"],
  browser: ["User Chrome lane", "Browser"],
  permissions: ["Agent access", "Permissions"],
  integrations: ["Optional capabilities", "Integrations"],
  activity: ["Diagnostics", "Activity"],
};

function clone(value) {
  return structuredClone(value);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = localizeUiText(value ?? "—");
}

function setDot(id, tone) {
  const element = $(id);
  if (!element) return;
  element.className = `status-dot is-${tone}`;
}

function setBadge(elementOrId, text, tone = "neutral") {
  const element = typeof elementOrId === "string" ? $(elementOrId) : elementOrId;
  if (!element) return;
  element.textContent = localizeUiText(text);
  element.className = `badge ${tone}`;
}

function toneForHealth(healthState) {
  if (healthState === "HEALTHY") return "good";
  if (healthState === "RECOVERING" || healthState === "DEGRADED") return "warn";
  if (healthState === "ATTENTION REQUIRED") return "bad";
  return "neutral";
}

function dotToneForHealth(healthState) {
  const tone = toneForHealth(healthState);
  return tone === "good" ? "good" : tone === "warn" ? "warn" : tone === "bad" ? "bad" : "neutral";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(localeForLanguage(state.language), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatUptime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return localizeUiText("Uptime unavailable");
  const seconds = Math.round(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return localizeUiText(`${days}d ${hours}h uptime`);
  if (hours > 0) return localizeUiText(`${hours}h ${minutes}m uptime`);
  return localizeUiText(`${Math.max(1, minutes)}m uptime`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} returned an unreadable response.`);
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `${path} failed with HTTP ${response.status}.`);
  }
  return body;
}

async function mutationJson(path, method, body) {
  const session = await requestJson("/api/v1/session");
  return await requestJson(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-equinox-csrf": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function showError(error) {
  setText("error-message", error instanceof Error ? error.message : String(error));
  $("error-banner").hidden = false;
}

function clearError() {
  $("error-banner").hidden = true;
  setText("error-message", "");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = localizeUiText(message);
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function markDirty() {
  if (state.restartRequired) return;
  state.dirty = true;
  setBadge("dirty-state", "Unsaved changes", "warn");
  setText("save-config-button", "Save configuration");
  $("save-config-button").disabled = false;
  if ($("save-agent-access-button")) {
    setText("save-agent-access-button", "Save access settings");
    $("save-agent-access-button").disabled = false;
  }
}

function markClean() {
  state.dirty = false;
  setBadge("dirty-state", "No unsaved changes", "neutral");
  setText("save-config-button", "Save configuration");
  $("save-config-button").disabled = true;
  if ($("save-agent-access-button")) {
    setText("save-agent-access-button", "Save access settings");
    $("save-agent-access-button").disabled = true;
  }
}

function setConfigEditingEnabled(enabled) {
  const ids = [
    "add-folder-button",
    "add-project-button",
    "default-project-select",
    "workspace-project-select",
    "downloads-root-select",
    "agent-files-access",
    "agent-terminal-access",
    "agent-desktop-access",
    "agent-web-access",
  ];
  for (const id of ids) {
    const element = $(id);
    if (element) element.disabled = !enabled;
  }
  for (const button of document.querySelectorAll(".project-actions button")) {
    button.disabled = !enabled || button.dataset.locked === "true";
  }
  if (!enabled) $("save-config-button").disabled = true;
  if (!enabled && $("save-agent-access-button")) $("save-agent-access-button").disabled = true;
}

function switchSection(section) {
  if (!sectionMeta[section]) return;
  state.activeSection = section;
  for (const button of document.querySelectorAll(".nav-item")) {
    const active = button.dataset.section === section;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const element of document.querySelectorAll(".page-section")) {
    const active = element.id === `section-${section}`;
    element.hidden = !active;
    element.classList.toggle("is-active", active);
  }
  const [kicker, title] = sectionMeta[section];
  setText("section-kicker", kicker);
  setText("section-title", title);
}

function statusLabel(active, ready = active) {
  if (ready) return "Ready";
  if (active) return "Connected, not ready";
  return "Disconnected";
}

function renderDashboard() {
  const status = state.status || {};
  const healthSummary = status.health || {};
  const runtimeHealth = healthSummary.state || "UNKNOWN";
  const runtimeTone = toneForHealth(runtimeHealth);
  const browser = status.browser || {};
  const peekaboo = status.peekaboo || {};
  const controlCenter = state.health?.controlCenter || {};
  const configStatus = status.config || {};

  setBadge("runtime-health-badge", runtimeHealth === "UNKNOWN" ? "Health unavailable" : runtimeHealth, runtimeTone);
  setBadge("health-summary-badge", runtimeHealth === "UNKNOWN" ? "Unknown" : runtimeHealth, runtimeTone);
  setText("runtime-version", status.server?.version ? `v${status.server.version}` : "—");
  setText("runtime-uptime", formatUptime(status.server?.uptimeSeconds));
  setText("sidebar-version", status.server?.version ? `Equinox Local ${status.server.version}` : "Local runtime");
  setText("sidebar-health-label", runtimeHealth === "HEALTHY" ? "Runtime healthy" : runtimeHealth.toLowerCase().replaceAll("_", " "));
  setDot("sidebar-health-dot", dotToneForHealth(runtimeHealth));

  const browserConsentRequired = browser.ready && browser.consentAccepted === false;
  const browserLabel = browserConsentRequired
    ? "Connected · consent required"
    : browser.ready && browser.controlEnabled === false
      ? "Connected · automation off"
      : browser.ready
        ? "Ready"
        : browser.active
          ? "Extension not connected"
          : "Unavailable";
  setText("browser-status", browserLabel);
  setText("browser-version", browser.extensionVersion ? `Extension ${browser.extensionVersion}` : "Extension version unavailable");
  setDot("browser-status-dot", browser.ready ? (browserConsentRequired || browser.controlEnabled === false ? "warn" : "good") : browser.active ? "warn" : "neutral");

  const peekabooReady = peekaboo.ready === true || (peekaboo.ready === undefined && peekaboo.active === true);
  const peekabooLabel = peekaboo.needsAttention
    ? "Needs attention"
    : peekabooReady
      ? "Ready"
      : peekaboo.available === false
        ? "Not available"
        : "Not checked";
  setText("peekaboo-status", peekabooLabel);
  setText("peekaboo-detail", peekaboo.version ? `Peekaboo ${peekaboo.version}` : "Optional desktop capability");
  setDot("peekaboo-status-dot", peekaboo.needsAttention ? "warn" : peekabooReady ? "good" : "neutral");

  setText("api-status", controlCenter.active ? "Listening" : "Unavailable");
  setText("api-detail", controlCenter.port ? `127.0.0.1:${controlCenter.port}` : "127.0.0.1 only");
  setDot("api-status-dot", controlCenter.active ? "good" : "bad");

  setText("project-count", String(configStatus.projectCount ?? Object.keys(state.config?.projects || {}).length));
  setText("folder-count", String(Object.keys(state.config?.fileRoots || {}).length));
  setText("default-project", state.config?.defaultProject || configStatus.defaultProject || "—");

  if (runtimeHealth === "HEALTHY") {
    setText("health-summary-title", "Everything looks healthy");
    setText("health-summary-copy", "The bounded runtime health window has no unresolved warnings that need your attention.");
  } else if (runtimeHealth === "UNKNOWN") {
    setText("health-summary-title", "Runtime health is unavailable");
    setText("health-summary-copy", "The management API is reachable, but no runtime health summary was returned.");
  } else {
    const count = Number(healthSummary.reasonCount || 0);
    setText("health-summary-title", `${count || "Some"} item${count === 1 ? "" : "s"} may need attention`);
    setText("health-summary-copy", "Open the diagnostics tools for detail. The Control Center summary intentionally avoids exposing raw runtime logs.");
  }
  setText("health-event-count", `${healthSummary.recentEventCount ?? 0} recent events`);
  setText("health-evaluated-at", healthSummary.evaluatedAt ? `Evaluated ${formatDate(healthSummary.evaluatedAt)}` : "Not evaluated yet");
}

function renderOnboarding() {
  const onboarding = state.onboarding || {};
  const card = $("onboarding-card");
  if (!card) return;

  const connected = onboarding.available === true && onboarding.connectedThroughTunnel === true;
  card.hidden = onboarding.available !== true || connected;
  if (card.hidden) return;

  const runtimeReady = Boolean(state.health?.controlCenter?.active && state.status?.server?.version);
  const workspaceReady = Boolean(
    state.config?.projects?.workspace &&
    state.config?.runtime?.workspaceProject === "workspace"
  );
  const browserReady = Boolean(state.status?.browser?.ready);

  setBadge("setup-runtime-status", runtimeReady ? "Ready" : "Checking", runtimeReady ? "good" : "neutral");
  setBadge("setup-workspace-status", workspaceReady ? "Ready" : "Needs attention", workspaceReady ? "good" : "warn");
  setBadge("setup-browser-status", browserReady ? "Ready" : "Optional", browserReady ? "good" : "neutral");

  if (onboarding.needsAttention) {
    setBadge("setup-tunnel-status", "Needs attention", "warn");
    setBadge("onboarding-badge", "Action needed", "warn");
    setText("onboarding-copy", onboarding.issue || "The saved tunnel connection needs attention. Re-enter the Runtime API key to repair it.");
  } else if (onboarding.transportConfigured) {
    setBadge("setup-tunnel-status", "Restarting", "warn");
    setBadge("onboarding-badge", "Connecting", "warn");
    setText("onboarding-copy", "Tunnel settings are saved. Equinox Local is switching from local-only setup mode to the private ChatGPT connection.");
  } else {
    setBadge("setup-tunnel-status", "Not connected", "warn");
    setBadge("onboarding-badge", "Setup needed", "warn");
    setText("onboarding-copy", "Your local runtime is ready. Add the OpenAI tunnel credentials to finish connecting Equinox Local to ChatGPT.");
  }

  const tunnelIdInput = $("onboarding-tunnel-id");
  if (tunnelIdInput && document.activeElement !== tunnelIdInput && onboarding.tunnelId && !tunnelIdInput.value) {
    tunnelIdInput.value = onboarding.tunnelId;
  }
  const connectButton = $("onboarding-connect-button");
  const runtimeKeyInput = $("onboarding-runtime-key");
  if (connectButton) {
    connectButton.disabled = state.onboardingBusy;
    connectButton.textContent = localizeUiText(state.onboardingBusy ? "Connecting…" : "Save & connect");
  }
  if (tunnelIdInput) tunnelIdInput.disabled = state.onboardingBusy;
  if (runtimeKeyInput) runtimeKeyInput.disabled = state.onboardingBusy;
  $("onboarding-reconnect").hidden = !state.onboardingBusy;
}

function renderDoctor() {
  const doctor = state.doctor || {};
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const attention = doctor.summary?.attention ?? 0;
  const optional = doctor.summary?.optional ?? 0;
  const healthy = doctor.state === "HEALTHY" && attention === 0;

  setBadge("doctor-badge", healthy ? "Healthy" : "Needs attention", healthy ? "good" : "warn");
  setText("doctor-title", healthy ? "Your setup checks out" : "A few setup checks need attention");
  setText(
    "doctor-copy",
    healthy
      ? "Equinox Local checked the managed runtime, private configuration, update path and optional bridges without exposing local paths or secrets."
      : "Review the checks below. Optional items do not block core Equinox Local, but attention items should be fixed before public-style use.",
  );
  setText("doctor-summary", `${doctor.summary?.pass ?? 0} passed · ${attention} attention · ${optional} optional`);
  setText("doctor-checked-at", doctor.checkedAt ? `Checked ${formatDate(doctor.checkedAt)}` : "Not checked yet");

  const list = $("doctor-list");
  if (!list) return;
  list.replaceChildren();
  for (const item of checks) {
    const row = document.createElement("div");
    row.className = `doctor-check is-${item.status || "optional"}`;

    const indicator = document.createElement("span");
    indicator.className = "doctor-check-indicator";
    indicator.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = localizeUiText(item.label || "Check");
    const detail = document.createElement("small");
    detail.textContent = localizeDoctorDetail(item);
    copy.append(title, detail);

    const badge = document.createElement("span");
    setBadge(badge, item.status === "pass" ? "Ready" : item.status === "attention" ? "Attention" : "Optional", item.status === "pass" ? "good" : item.status === "attention" ? "warn" : "neutral");

    row.append(indicator, copy, badge);
    list.append(row);
  }
}

function renderUpdate() {
  const update = state.update || {};
  const checkButton = $("check-update-button");
  const installButton = $("install-update-button");
  const current = update.currentVersion || state.status?.server?.version || null;
  setText("update-version", current ? `Current version ${current}` : "Current version unavailable");
  setText("update-checked-at", update.checkedAt ? `Checked ${formatDate(update.checkedAt)}` : "Not checked yet");

  if (update.restartScheduledFor) {
    setText("update-title", `Restarting into Equinox Local ${update.restartScheduledFor}`);
    setText("update-copy", "The verified release is prepared. Control Center may disconnect briefly while the managed runtime restarts and verifies the new version; automatic rollback is used if health verification fails.");
    setBadge("update-badge", "Restart scheduled", "warn");
  } else if (state.updateApplyBusy || update.applying) {
    setText("update-title", `Preparing Equinox Local ${update.latestVersion || "update"}`);
    setText("update-copy", "Downloading the signed artifact, verifying its exact size and SHA-256 digest, then staging the release before any runtime switch occurs.");
    setBadge("update-badge", "Preparing", "warn");
  } else if (update.installationKind === "source") {
    setText("update-title", "Source checkout");
    setText("update-copy", "This development checkout is never self-updated. Public shell-bootstrap installs use the managed signed update channel.");
    setBadge("update-badge", "Development", "neutral");
  } else if (!update.managedInstallation) {
    setText("update-title", "Managed updates unavailable");
    setText("update-copy", update.reason || "This installation is not eligible for managed self-update.");
    setBadge("update-badge", "Unavailable", "warn");
  } else if (!update.configured) {
    setText("update-title", "Update channel not provisioned");
    setText("update-copy", update.reason || "A trusted stable update signing key has not been provisioned in this build yet.");
    setBadge("update-badge", "Not configured", "warn");
  } else if (update.lastError) {
    setText("update-title", "Update check needs attention");
    setText("update-copy", update.lastError);
    setBadge("update-badge", "Check failed", "bad");
  } else if (update.updateAvailable === true) {
    setText("update-title", `Equinox Local ${update.latestVersion} is available`);
    setText("update-copy", "The signed stable release is verified. Update & restart prepares it in a separate release directory, switches atomically, verifies runtime health and rolls back automatically if activation fails.");
    setBadge("update-badge", "Update available", "good");
  } else if (update.updateAvailable === false) {
    setText("update-title", "Equinox Local is up to date");
    setText("update-copy", "The signed stable update channel reports no newer version.");
    setBadge("update-badge", "Up to date", "good");
  } else {
    setText("update-title", "Stable update channel ready");
    setText("update-copy", "Check the signed stable manifest when you want to look for a newer Equinox Local release.");
    setBadge("update-badge", "Ready", "neutral");
  }

  const updateLocked = state.updateBusy || state.updateApplyBusy || Boolean(update.applying) || Boolean(update.restartScheduledFor);
  checkButton.disabled = updateLocked || !update.selfUpdateSupported;
  checkButton.textContent = localizeUiText(state.updateBusy ? "Checking…" : "Check for updates");

  const canApply = Boolean(
    update.selfUpdateSupported &&
    update.configured &&
    update.updateAvailable === true &&
    !update.lastError &&
    !update.restartScheduledFor
  );
  installButton.hidden = !canApply && !state.updateApplyBusy && !update.applying && !update.restartScheduledFor;
  installButton.disabled = updateLocked || !canApply;
  installButton.textContent = localizeUiText(state.updateApplyBusy || update.applying ? "Preparing update…" : update.restartScheduledFor ? "Restarting…" : "Update & restart");
}

function makeMiniBadge(text) {
  const badge = document.createElement("span");
  badge.className = "mini-badge";
  badge.textContent = localizeUiText(text);
  return badge;
}

function createRootRow(kind, id, definition) {
  const row = document.createElement("article");
  row.className = "project-row";

  const main = document.createElement("div");
  main.className = "project-main";

  const titleLine = document.createElement("div");
  titleLine.className = "project-title-line";
  const title = document.createElement("strong");
  title.textContent = definition.name;
  const idChip = document.createElement("span");
  idChip.className = "code-chip";
  idChip.textContent = id;
  titleLine.append(title, idChip);

  const root = document.createElement("p");
  root.className = "project-path";
  root.title = definition.root;
  root.textContent = definition.root;

  const badges = document.createElement("div");
  badges.className = "project-badges";
  if (kind === "project") {
    badges.append(makeMiniBadge("Project"));
    badges.append(makeMiniBadge(definition.worktrees === false ? "Managed worktrees off" : "Managed worktrees on"));
    if (state.config.defaultProject === id) badges.append(makeMiniBadge("Default"));
    if (state.config.runtime?.workspaceProject === id) badges.append(makeMiniBadge("Workspace"));
  } else {
    badges.append(makeMiniBadge("Read-only folder"));
    if (state.config.runtime?.downloadsRoot === id) badges.append(makeMiniBadge("Downloads root"));
  }
  main.append(titleLine, root, badges);

  const actions = document.createElement("div");
  actions.className = "project-actions";
  const edit = document.createElement("button");
  edit.className = "row-button";
  edit.type = "button";
  edit.textContent = localizeUiText("Edit");
  edit.addEventListener("click", () => openRootDialog({ mode: "edit", kind, id }));

  const remove = document.createElement("button");
  remove.className = "row-button danger";
  remove.type = "button";
  remove.textContent = localizeUiText("Remove");
  const locked = kind === "project"
    ? state.config.defaultProject === id || state.config.runtime?.workspaceProject === id
    : state.config.runtime?.downloadsRoot === id;
  remove.dataset.locked = locked ? "true" : "false";
  remove.disabled = locked || state.restartRequired;
  remove.title = localizeUiText(locked ? "Change the runtime routing first before removing this root." : "Remove from the draft configuration");
  remove.addEventListener("click", () => removeRoot(kind, id));

  edit.disabled = state.restartRequired;
  actions.append(edit, remove);
  row.append(main, actions);
  return row;
}

function populateSelect(select, entries, selectedId) {
  select.replaceChildren();
  for (const [id, definition] of entries) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${definition.name} (${id})`;
    option.selected = id === selectedId;
    select.append(option);
  }
}

function renderProjects() {
  if (!state.config) return;
  const projects = Object.entries(state.config.projects || {});
  const fileRoots = Object.entries(state.config.fileRoots || {});
  const list = $("project-list");
  list.replaceChildren();
  for (const [id, definition] of projects) list.append(createRootRow("project", id, definition));
  for (const [id, definition] of fileRoots) list.append(createRootRow("fileRoot", id, definition));

  const folderLabel = fileRoots.length === 1 ? "read-only folder" : "read-only folders";
  setText("root-count-label", `${projects.length} projects · ${fileRoots.length} ${folderLabel}`);
  populateSelect($("default-project-select"), projects, state.config.defaultProject);
  populateSelect($("workspace-project-select"), projects, state.config.runtime?.workspaceProject);
  populateSelect($("downloads-root-select"), fileRoots, state.config.runtime?.downloadsRoot);
  setText("control-center-address", `127.0.0.1:${state.config.controlCenter?.port ?? "—"}`);
  setConfigEditingEnabled(!state.restartRequired);
}

function renderPermissions() {
  const list = $("permissions-list");
  list.replaceChildren();
  if (!state.config) return;

  const access = state.config.agentAccess || {
    files: "selected",
    terminal: true,
    desktop: true,
    browser: true,
  };
  $("agent-files-access").value = access.files;
  $("agent-terminal-access").checked = access.terminal !== false;
  $("agent-desktop-access").checked = access.desktop !== false;
  $("agent-web-access").checked = access.browser !== false;
  const maximum =
    access.files === "full" && access.terminal && access.desktop && access.browser;
  setBadge(
    "agent-access-badge",
    maximum ? "Maximum useful access" : "Restricted access",
    maximum ? "good" : "warn",
  );
  $("save-agent-access-button").disabled = !state.dirty || state.restartRequired;

  for (const [id, definition] of Object.entries(state.config.projects || {})) {
    const card = document.createElement("article");
    card.className = "permission-card";
    const meta = document.createElement("div");
    meta.className = "permission-meta";
    const title = document.createElement("h4");
    title.textContent = definition.name;
    const badge = makeMiniBadge(access.files === "full" ? "Configured shortcut" : "Project boundary");
    meta.append(title, badge);
    const copy = document.createElement("p");
    copy.textContent = localizeUiText(
      access.files === "full"
        ? "This configured project remains a convenient named shortcut. Full access can also address home or other accessible folders without pre-registering them."
        : "Project tools stay contained to this configured root.",
    );
    const path = document.createElement("span");
    path.className = "permission-path";
    path.title = definition.root;
    path.textContent = `${id} · ${definition.root}`;
    card.append(meta, copy, path);
    list.append(card);
  }

  for (const [id, definition] of Object.entries(state.config.fileRoots || {})) {
    const card = document.createElement("article");
    card.className = "permission-card";
    const meta = document.createElement("div");
    meta.className = "permission-meta";
    const title = document.createElement("h4");
    title.textContent = definition.name;
    const badge = makeMiniBadge("Read only");
    meta.append(title, badge);
    const copy = document.createElement("p");
    copy.textContent = localizeUiText("This extra file root is intentionally read-only in V1 and cannot be promoted to writable from the Control Center.");
    const path = document.createElement("span");
    path.className = "permission-path";
    path.title = definition.root;
    path.textContent = `${id} · ${definition.root}`;
    card.append(meta, copy, path);
    list.append(card);
  }
}

function renderUninstall() {
  const card = $("uninstall-card");
  if (!card) return;
  const managed = state.doctor?.managed === true;
  card.hidden = !managed;
  if (!managed) return;

  const removeData = $("uninstall-remove-data");
  const confirmation = $("uninstall-confirmation");
  const button = $("uninstall-button");
  const status = $("uninstall-status");
  const destructive = Boolean(removeData?.checked);
  const confirmed = confirmation?.value === "UNINSTALL";

  setBadge(
    "uninstall-badge",
    state.uninstallScheduled ? "Stopping" : destructive ? "Deletes user data" : "Preserves user data",
    state.uninstallScheduled || destructive ? "warn" : "neutral",
  );
  setText(
    "uninstall-confirmation-help",
    destructive
      ? "The managed runtime, credentials, Equinox Workspace and saved Control Center configuration will all be permanently removed."
      : "The managed runtime and credentials will be removed; Equinox Workspace and saved Control Center configuration will remain for a future reinstall.",
  );

  if (removeData) removeData.disabled = state.uninstallBusy;
  if (confirmation) confirmation.disabled = state.uninstallBusy;
  if (button) {
    button.disabled = state.uninstallBusy || !confirmed;
    button.textContent = state.uninstallScheduled
      ? "Uninstall scheduled"
      : state.uninstallBusy
        ? "Scheduling uninstall…"
        : destructive
          ? "Uninstall & delete local data"
          : "Uninstall Equinox Local";
  }
  if (status) status.hidden = !state.uninstallScheduled;
}

function createIntegrationCard(titleText, description, statusText, tone, actions = []) {
  const card = document.createElement("article");
  card.className = "integration-card";
  const meta = document.createElement("div");
  meta.className = "integration-meta";
  const title = document.createElement("h4");
  title.textContent = localizeUiText(titleText);
  const badge = document.createElement("span");
  setBadge(badge, statusText, tone);
  meta.append(title, badge);
  const copy = document.createElement("p");
  copy.textContent = localizeUiText(description);
  card.append(meta, copy);

  if (actions.length > 0) {
    const actionRow = document.createElement("div");
    actionRow.className = "integration-actions";
    for (const action of actions) {
      const control = document.createElement(action.href ? "a" : "button");
      control.className = `button ${action.primary ? "primary" : "secondary"}`;
      control.textContent = localizeUiText(action.label);
      if (action.href) {
        control.href = action.href;
        control.target = "_blank";
        control.rel = "noopener noreferrer";
      } else {
        control.type = "button";
        control.disabled = Boolean(action.disabled) || state.integrationBusy;
        control.addEventListener("click", action.onClick);
      }
      actionRow.append(control);
    }
    card.append(actionRow);
  }
  return card;
}

function createTelegramIntegrationCard() {
  const telegram = state.telegram;
  const configured = Boolean(telegram?.configured && telegram?.ready);
  const needsAttention = Boolean(telegram?.needsAttention);
  const card = createIntegrationCard(
    "Telegram",
    configured
      ? `Bot API is connected${telegram.userIdHint ? ` to user ${telegram.userIdHint}` : ""}. Agents can send messages only to this Telegram account; the recipient cannot be changed by an agent.`
      : needsAttention
        ? "Saved Telegram credentials need attention. Reconnect the bot to replace them safely."
        : "Connect a Telegram bot to one Telegram account. Groups and channels are not supported, and agents cannot choose another recipient.",
    configured ? "Ready" : needsAttention ? "Needs attention" : "Not connected",
    configured ? "good" : needsAttention ? "warn" : "neutral",
    configured
      ? [
          { label: "Send test", onClick: testTelegramConnection },
          { label: "Disconnect", onClick: disconnectTelegramConnection },
        ]
      : [],
  );

  if (!configured) {
    const form = document.createElement("form");
    form.className = "integration-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void connectTelegramIntegration();
    });

    const tokenLabel = document.createElement("label");
    tokenLabel.className = "field";
    const tokenTitle = document.createElement("span");
    tokenTitle.textContent = localizeUiText("Bot token");
    const tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.autocomplete = "off";
    tokenInput.spellcheck = false;
    tokenInput.placeholder = "123456789:AA…";
    tokenInput.value = state.telegramBotToken;
    tokenInput.disabled = state.integrationBusy;
    tokenInput.addEventListener("input", () => { state.telegramBotToken = tokenInput.value; });
    tokenLabel.append(tokenTitle, tokenInput);

    const chatLabel = document.createElement("label");
    chatLabel.className = "field";
    const chatTitle = document.createElement("span");
    chatTitle.textContent = localizeUiText("Your Telegram ID");
    const chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.inputMode = "numeric";
    chatInput.autocomplete = "off";
    chatInput.spellcheck = false;
    chatInput.placeholder = "123456789";
    chatInput.value = state.telegramUserId;
    chatInput.disabled = state.integrationBusy;
    chatInput.addEventListener("input", () => { state.telegramUserId = chatInput.value; });
    chatLabel.append(chatTitle, chatInput);

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "button primary";
    button.textContent = localizeUiText(state.integrationBusy ? "Connecting…" : "Connect & test");
    button.disabled = state.integrationBusy;
    form.append(tokenLabel, chatLabel, button);
    card.append(form);
  }
  return card;
}

function renderIntegrations() {
  const list = $("integration-list");
  list.replaceChildren();
  const browser = state.status?.browser || {};
  const peekaboo = state.status?.peekaboo || {};
  const browserStatus = browser.ready
    ? browser.consentAccepted === false
      ? "Consent required"
      : (browser.controlEnabled === false ? "Automation off" : "Ready")
    : browser.active ? "Extension not connected" : "Unavailable";
  const browserTone = browser.ready
    ? (browser.consentAccepted === false || browser.controlEnabled === false ? "warn" : "good")
    : "neutral";
  const peekabooReady = peekaboo.ready === true || (peekaboo.ready === undefined && peekaboo.active === true);
  const peekabooStatus = peekaboo.needsAttention
    ? "Needs attention"
    : peekabooReady
      ? "Ready"
      : peekaboo.available === false
        ? "Not available"
        : "Not checked";
  const peekabooTone = peekaboo.needsAttention ? "warn" : peekabooReady ? "good" : "neutral";

  list.append(
    createIntegrationCard(
      "Equinox Browser",
      browser.extensionVersion ? `First-party Chrome bridge · extension ${browser.extensionVersion}.` : "First-party Chrome bridge through the extension and Native Messaging.",
      browserStatus,
      browserTone,
      [
        { label: browser.ready ? "Chrome Web Store" : "Install extension", href: EQUINOX_BROWSER_STORE_URL, primary: !browser.ready },
        { label: "Browser settings", onClick: () => switchSection("browser") },
      ],
    ),
    createIntegrationCard(
      "Peekaboo desktop bridge",
      peekaboo.version
        ? `Optional macOS desktop capability · Peekaboo ${peekaboo.version}.`
        : "Optional macOS desktop capability. It is not required for core Equinox Local filesystem or Git operations.",
      peekabooStatus,
      peekabooTone,
    ),
    createTelegramIntegrationCard(),
  );
}

function browserSettingsFromStatus() {
  const browser = state.status?.browser || {};
  if (
    typeof browser.controlEnabled !== "boolean" ||
    typeof browser.agentCursorEnabled !== "boolean" ||
    typeof browser.agentCursorName !== "string"
  ) {
    return null;
  }
  return {
    enabled: browser.controlEnabled,
    agentCursorEnabled: browser.agentCursorEnabled,
    agentCursorName: browser.agentCursorName,
  };
}

function renderBrowserPage() {
  const browser = state.status?.browser || {};
  const consentRequired = browser.ready && browser.consentAccepted === false;
  const controlOff = browser.ready && !consentRequired && browser.controlEnabled === false;
  const label = consentRequired
    ? "Connected · consent required"
    : controlOff
      ? "Connected · automation off"
      : browser.ready
        ? "Ready"
        : browser.active
          ? "Extension not connected"
          : "Unavailable";
  setText("browser-page-status", label);
  setBadge(
    "browser-page-badge",
    browser.ready ? (consentRequired ? "Consent required" : controlOff ? "Automation off" : "Ready") : browser.active ? "Extension not connected" : "Unavailable",
    browser.ready ? (consentRequired || controlOff ? "warn" : "good") : "neutral",
  );
  setText("browser-page-version", browser.extensionVersion || "—");
  setText("browser-connected-at", formatDate(browser.connectedAt));
  setText("browser-control-state", consentRequired ? "Consent required" : typeof browser.controlEnabled === "boolean" ? (browser.controlEnabled ? "Allowed" : "Off") : "Unavailable");

  const baseline = browserSettingsFromStatus();
  if (!state.browserSettingsDirty) state.browserDraft = baseline ? { ...baseline } : null;
  const available = Boolean(browser.ready && baseline && state.browserDraft);
  const disabled = !available || state.browserSettingsBusy;
  const controlToggle = $("browser-control-toggle");
  const cursorToggle = $("browser-cursor-toggle");
  const nameInput = $("browser-agent-name");
  const applyButton = $("apply-browser-settings");

  controlToggle.disabled = disabled || consentRequired;
  cursorToggle.disabled = disabled;
  nameInput.disabled = disabled;
  if (state.browserDraft) {
    controlToggle.checked = state.browserDraft.enabled;
    cursorToggle.checked = state.browserDraft.agentCursorEnabled;
    nameInput.value = state.browserDraft.agentCursorName;
  } else {
    controlToggle.checked = false;
    cursorToggle.checked = false;
    nameInput.value = "";
  }
  applyButton.disabled = disabled || !state.browserSettingsDirty;
  applyButton.textContent = localizeUiText(state.browserSettingsBusy ? "Applying…" : "Apply browser settings");
  setText(
    "browser-settings-note",
    consentRequired
      ? "Open the Equinox Browser popup, review the data-use disclosure, and enable browser control there. The local settings channel remains connected."
      : available
        ? "Settings apply immediately through Native Messaging and do not require an Equinox Local restart."
        : "Connect Equinox Browser to manage these settings from Control Center.",
  );
}

function activityTone(event) {
  if (event?.severity === "critical" || event?.severity === "error") return "bad";
  if (event?.severity === "warn") return "warn";
  if (["healthy", "recovered", "completed"].includes(event?.status)) return "good";
  return "neutral";
}

function renderActivity() {
  const controlCenter = state.health?.controlCenter || {};
  setText("request-count", String(controlCenter.requestCount ?? 0));
  setText("mutation-count", String(controlCenter.mutationCount ?? 0));
  setText("activity-event-count", String(state.activity.length));

  const timeline = $("activity-timeline");
  timeline.replaceChildren();
  if (state.activity.length === 0) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = localizeUiText("No sanitized runtime events were recorded in the last six hours.");
    timeline.append(empty);
    return;
  }

  for (const event of state.activity) {
    const item = document.createElement("article");
    item.className = "activity-item";
    const marker = document.createElement("span");
    marker.className = `activity-marker is-${activityTone(event)}`;
    marker.setAttribute("aria-hidden", "true");
    const body = document.createElement("div");
    body.className = "activity-body";
    const heading = document.createElement("div");
    heading.className = "activity-heading";
    const title = document.createElement("strong");
    title.textContent = localizeRuntimeEventMessage(event.message || event.type || "Runtime event");
    const time = document.createElement("time");
    time.dateTime = event.timestamp || "";
    time.textContent = formatDate(event.timestamp);
    heading.append(title, time);
    const meta = document.createElement("div");
    meta.className = "activity-meta";
    meta.append(
      makeMiniBadge(event.component || "runtime"),
      makeMiniBadge(event.type || "event"),
      makeMiniBadge(event.status || event.severity || "info"),
    );
    body.append(heading, meta);
    item.append(marker, body);
    timeline.append(item);
  }
}

function renderRuntimeRestartControl() {
  const button = $("restart-runtime-button");
  if (!button) return;
  button.disabled = state.restartBusy || !state.status?.server?.pid;
  button.textContent = localizeUiText(state.restartBusy ? "Restarting…" : "Restart");
}

function renderAll() {
  renderDashboard();
  renderOnboarding();
  renderDoctor();
  renderUpdate();
  renderProjects();
  renderPermissions();
  renderUninstall();
  renderIntegrations();
  renderBrowserPage();
  renderActivity();
  renderRuntimeRestartControl();
}

function updateRestartState() {
  $("restart-banner").hidden = !state.restartRequired;
  $("refresh-button").disabled = state.restartRequired || state.restartBusy;
  setConfigEditingEnabled(!state.restartRequired);
  renderRuntimeRestartControl();
}

async function refreshAll() {
  if (state.restartRequired) return;
  clearError();
  $("refresh-button").disabled = true;
  try {
    const [health, status, config, activity, update, onboarding, doctor, peekaboo, telegram] = await Promise.all([
      requestJson("/api/v1/health"),
      requestJson("/api/v1/status"),
      requestJson("/api/v1/config"),
      requestJson("/api/v1/activity").catch(() => ({ events: [] })),
      requestJson("/api/v1/update"),
      requestJson("/api/v1/onboarding"),
      requestJson("/api/v1/doctor"),
      requestJson("/api/v1/integrations/peekaboo").catch(() => ({ peekaboo: null })),
      requestJson("/api/v1/integrations/telegram").catch(() => ({ telegram: null })),
    ]);
    state.health = health;
    state.status = status.status;
    state.config = clone(config.config);
    state.revision = config.revision;
    state.activity = Array.isArray(activity.events) ? activity.events : [];
    state.update = update.update || null;
    state.onboarding = onboarding.onboarding || null;
    state.doctor = doctor.doctor || null;
    if (peekaboo.peekaboo) {
      state.status = {
        ...(state.status || {}),
        peekaboo: peekaboo.peekaboo,
      };
    }
    state.telegram = telegram.telegram || null;
    state.browserDraft = null;
    state.browserSettingsDirty = false;
    state.restartRequired = false;
    markClean();
    renderAll();
    state.lastRefreshedAt = new Date();
    renderLastRefreshed();
  } catch (error) {
    showError(error);
  } finally {
    $("refresh-button").disabled = state.restartRequired || state.restartBusy;
  }
}

function validateRootForm({ id, name, root }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) {
    return "Identifier must use lowercase letters, numbers, dots, underscores or hyphens.";
  }
  if (!name.trim() || name.trim().length > 100) return "Display name must be 1-100 characters.";
  if (!root.startsWith("/")) return "Folder path must be absolute and start with /.";
  if (root === "/") return "The filesystem root itself cannot be granted.";
  if (root.length > 1024) return "Folder path is too long.";
  return null;
}

function openRootDialog({ mode, kind, id = null }) {
  if (!state.config || state.restartRequired) return;
  state.dialogMode = mode;
  state.dialogKind = kind;
  state.editingId = id;
  const isProject = kind === "project";
  const isEdit = mode === "edit";
  const definition = isEdit
    ? (isProject ? state.config.projects[id] : state.config.fileRoots[id])
    : null;

  $("root-kind").value = kind;
  $("root-id").value = id || "";
  $("root-id").disabled = isEdit;
  $("root-name").value = definition?.name || "";
  $("root-path").value = definition?.root || "";
  $("root-worktrees").checked = definition?.worktrees !== false;
  $("worktrees-field").hidden = !isProject;
  $("readonly-note").hidden = isProject;
  $("dialog-error").hidden = true;
  setText("dialog-kicker", isProject ? "Project" : "Read-only folder");
  setText("dialog-title", `${isEdit ? "Edit" : "Add"} ${isProject ? "project" : "read-only folder"}`);
  $("root-dialog").showModal();
  setTimeout(() => (isEdit ? $("root-name") : $("root-id")).focus(), 0);
}

function closeRootDialog() {
  $("root-dialog").close();
  state.dialogMode = null;
  state.editingId = null;
}

function removeRoot(kind, id) {
  if (!state.config || state.restartRequired) return;
  const definition = kind === "project" ? state.config.projects[id] : state.config.fileRoots[id];
  if (!definition) return;
  const confirmed = window.confirm(state.language === "tr"
    ? `“${definition.name}” taslak yapılandırmadan kaldırılsın mı? Diskten hiçbir şey silinmez.`
    : `Remove “${definition.name}” from the draft configuration? Nothing is deleted from disk.`);
  if (!confirmed) return;
  if (kind === "project") delete state.config.projects[id];
  else delete state.config.fileRoots[id];
  markDirty();
  renderAll();
}

function applyRootForm(event) {
  event.preventDefault();
  if (!state.config || state.restartRequired) return;
  const kind = state.dialogKind;
  const id = (state.editingId || $("root-id").value).trim();
  const name = $("root-name").value.trim();
  const root = $("root-path").value.trim();
  const error = validateRootForm({ id, name, root });
  if (error) {
    setText("dialog-error", error);
    $("dialog-error").hidden = false;
    return;
  }

  if (state.dialogMode === "add") {
    if (Object.hasOwn(state.config.projects, id) || Object.hasOwn(state.config.fileRoots, id)) {
      setText("dialog-error", "That identifier is already in use by another configured root.");
      $("dialog-error").hidden = false;
      return;
    }
  }

  const duplicate = [
    ...Object.entries(state.config.projects || {}),
    ...Object.entries(state.config.fileRoots || {}),
  ].some(([otherId, definition]) => otherId !== id && definition.root === root);
  if (duplicate) {
    setText("dialog-error", "That folder path is already configured under another root.");
    $("dialog-error").hidden = false;
    return;
  }

  if (kind === "project") {
    state.config.projects[id] = {
      name,
      root,
      worktrees: $("root-worktrees").checked,
    };
  } else {
    state.config.fileRoots[id] = {
      name,
      root,
      access: "read-only",
    };
  }
  markDirty();
  renderAll();
  closeRootDialog();
  showToast("Draft updated. Save when you are ready.");
}

async function chooseFolderForDialog() {
  if (state.pickerBusy || state.restartRequired) return;
  const button = $("choose-folder-button");
  state.pickerBusy = true;
  button.disabled = true;
  button.textContent = localizeUiText("Choosing…");
  $("dialog-error").hidden = true;
  try {
    const result = await mutationJson("/api/v1/folder-picker", "POST", {});
    if (result.cancelled) {
      showToast("Folder selection cancelled.");
      return;
    }
    if (typeof result.path === "string" && result.path.startsWith("/")) {
      $("root-path").value = result.path;
      $("root-path").focus();
    }
  } catch (error) {
    setText("dialog-error", error instanceof Error ? error.message : String(error));
    $("dialog-error").hidden = false;
  } finally {
    state.pickerBusy = false;
    button.disabled = false;
    button.textContent = localizeUiText("Choose folder…");
  }
}

function updateBrowserDraftFromInputs() {
  const baseline = browserSettingsFromStatus();
  if (!baseline || state.browserSettingsBusy) return;
  state.browserDraft = {
    enabled: $("browser-control-toggle").checked,
    agentCursorEnabled: $("browser-cursor-toggle").checked,
    agentCursorName: $("browser-agent-name").value.slice(0, 32),
  };
  state.browserSettingsDirty =
    state.browserDraft.enabled !== baseline.enabled ||
    state.browserDraft.agentCursorEnabled !== baseline.agentCursorEnabled ||
    state.browserDraft.agentCursorName !== baseline.agentCursorName;
  renderBrowserPage();
}

async function saveBrowserSettings() {
  if (!state.browserDraft || !state.browserSettingsDirty || state.browserSettingsBusy) return;
  clearError();
  state.browserSettingsBusy = true;
  renderBrowserPage();
  try {
    const result = await mutationJson("/api/v1/browser/settings", "PUT", state.browserDraft);
    const settings = result.settings || {};
    state.status.browser = {
      ...(state.status?.browser || {}),
      controlEnabled: typeof settings.enabled === "boolean" ? settings.enabled : state.browserDraft.enabled,
      agentCursorEnabled: typeof settings.agentCursorEnabled === "boolean" ? settings.agentCursorEnabled : state.browserDraft.agentCursorEnabled,
      agentCursorName: typeof settings.agentCursorName === "string" ? settings.agentCursorName : state.browserDraft.agentCursorName,
      nativeHostConnected: Boolean(settings.nativeHostConnected ?? state.status?.browser?.nativeHostConnected),
      localConnected: Boolean(settings.localConnected ?? state.status?.browser?.localConnected),
    };
    state.browserDraft = browserSettingsFromStatus();
    state.browserSettingsDirty = false;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    renderDashboard();
    renderBrowserPage();
    renderIntegrations();
    renderActivity();
    showToast("Browser settings updated.");
  } catch (error) {
    showError(error);
  } finally {
    state.browserSettingsBusy = false;
    renderBrowserPage();
  }
}

async function connectTelegramIntegration() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram", "PUT", {
      botToken: state.telegramBotToken.trim(),
      telegramUserId: state.telegramUserId.trim(),
    });
    state.telegram = result.telegram || null;
    state.telegramBotToken = "";
    state.telegramUserId = "";
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram connected and test message sent.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function testTelegramConnection() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/telegram/test", "POST", {});
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram test message sent.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function disconnectTelegramConnection() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/telegram/disconnect", "POST", {});
    state.telegram = { configured: false, ready: false, needsAttention: false, userIdHint: null };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram disconnected.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function checkForUpdates() {
  if (state.updateBusy || !state.update?.selfUpdateSupported) return;
  clearError();
  state.updateBusy = true;
  renderUpdate();
  try {
    const result = await mutationJson("/api/v1/update/check", "POST", {});
    state.update = result.update || state.update;
    renderUpdate();
    showToast(state.update?.updateAvailable ? `Equinox Local ${state.update.latestVersion} is available.` : "Equinox Local is up to date.");
  } catch (error) {
    showError(error);
    try {
      const latest = await requestJson("/api/v1/update");
      state.update = latest.update || state.update;
    } catch {
      // Keep the last safe update snapshot if the status read also fails.
    }
  } finally {
    state.updateBusy = false;
    renderUpdate();
  }
}

async function applyAvailableUpdate() {
  if (
    state.updateApplyBusy ||
    state.updateBusy ||
    !state.update?.selfUpdateSupported ||
    state.update?.updateAvailable !== true ||
    state.update?.lastError
  ) return;

  clearError();
  state.updateApplyBusy = true;
  renderUpdate();
  try {
    const result = await mutationJson("/api/v1/update/apply", "POST", {});
    const scheduled = result.result || {};
    state.update = {
      ...(state.update || {}),
      applying: false,
      restartScheduledFor: scheduled.targetVersion || state.update?.latestVersion || null,
    };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    renderUpdate();
    renderActivity();
    showToast(`Equinox Local ${scheduled.targetVersion || "update"} is prepared. Restarting safely…`);
  } catch (error) {
    showError(error);
    try {
      const latest = await requestJson("/api/v1/update");
      state.update = latest.update || state.update;
    } catch {
      // Keep the last safe update snapshot if the status read also fails.
    }
  } finally {
    state.updateApplyBusy = false;
    renderUpdate();
  }
}

function stopOnboardingReconnect() {
  if (state.onboardingReconnectTimer) {
    clearTimeout(state.onboardingReconnectTimer);
    state.onboardingReconnectTimer = null;
  }
}

async function pollOnboardingReconnect(attempt = 0) {
  const maxAttempts = 30;
  try {
    const [onboarding, status, health, doctor] = await Promise.all([
      requestJson("/api/v1/onboarding"),
      requestJson("/api/v1/status"),
      requestJson("/api/v1/health"),
      requestJson("/api/v1/doctor"),
    ]);
    state.onboarding = onboarding.onboarding || state.onboarding;
    state.status = status.status || state.status;
    state.health = health;
    state.doctor = doctor.doctor || state.doctor;
    if (state.onboarding?.connectedThroughTunnel) {
      stopOnboardingReconnect();
      state.onboardingBusy = false;
      renderAll();
      showToast("Equinox Local is connected to ChatGPT.");
      return;
    }
  } catch {
    // A short connection failure is expected while the LaunchAgent restarts.
  }

  if (attempt + 1 >= maxAttempts) {
    stopOnboardingReconnect();
    state.onboardingBusy = false;
    renderOnboarding();
    showError(new Error("Equinox Local did not return through the tunnel yet. Your saved credentials were kept locally; refresh to inspect the current setup state."));
    return;
  }

  state.onboardingReconnectTimer = setTimeout(() => {
    void pollOnboardingReconnect(attempt + 1);
  }, 1_200);
}

async function submitTunnelOnboarding(event) {
  event.preventDefault();
  if (state.onboardingBusy || state.onboarding?.available !== true) return;

  const tunnelIdInput = $("onboarding-tunnel-id");
  const runtimeKeyInput = $("onboarding-runtime-key");
  const tunnelId = tunnelIdInput.value.trim();
  const runtimeKey = runtimeKeyInput.value;

  clearError();
  stopOnboardingReconnect();
  state.onboardingBusy = true;
  renderOnboarding();
  try {
    const result = await mutationJson("/api/v1/onboarding/tunnel", "POST", {
      tunnelId,
      runtimeKey,
    });
    runtimeKeyInput.value = "";
    state.onboarding = {
      ...(state.onboarding || {}),
      available: true,
      managed: true,
      transportConfigured: true,
      connectedThroughTunnel: false,
      needsAttention: false,
      tunnelId: result.result?.tunnelId || tunnelId,
    };
    renderOnboarding();
    showToast("Tunnel settings saved. Equinox Local is restarting safely…");
    void pollOnboardingReconnect();
  } catch (error) {
    state.onboardingBusy = false;
    renderOnboarding();
    showError(error);
  }
}

async function submitUninstall(event) {
  event.preventDefault();
  if (state.uninstallBusy || state.uninstallScheduled || state.doctor?.managed !== true) return;

  const confirmation = $("uninstall-confirmation");
  const removeData = $("uninstall-remove-data");
  if (confirmation?.value !== "UNINSTALL") {
    renderUninstall();
    return;
  }

  clearError();
  state.uninstallBusy = true;
  renderUninstall();
  try {
    const response = await mutationJson("/api/v1/uninstall", "POST", {
      confirm: "UNINSTALL",
      removeUserData: Boolean(removeData?.checked),
    });
    state.uninstallScheduled = response.result?.scheduled === true;
    if (!state.uninstallScheduled) throw new Error("Equinox Local did not confirm the uninstall schedule.");
    renderUninstall();
    showToast(removeData?.checked
      ? "Uninstall scheduled. Local user data will also be removed."
      : "Uninstall scheduled. Workspace and configuration will be preserved.");
  } catch (error) {
    state.uninstallBusy = false;
    state.uninstallScheduled = false;
    renderUninstall();
    showError(error);
  }
}

function stopRuntimeRestartPolling() {
  if (state.runtimeRestartTimer) {
    clearTimeout(state.runtimeRestartTimer);
    state.runtimeRestartTimer = null;
  }
}

async function pollRuntimeRestart(previousPid, attempt = 0) {
  const maxAttempts = 45;
  try {
    const status = await requestJson("/api/v1/status");
    const currentPid = status.status?.server?.pid ?? null;
    if (currentPid && currentPid !== previousPid) {
      stopRuntimeRestartPolling();
      window.location.reload();
      return;
    }
  } catch {
    // A short connection failure is expected while the runtime restarts.
  }

  if (attempt + 1 >= maxAttempts) {
    stopRuntimeRestartPolling();
    state.restartBusy = false;
    renderRuntimeRestartControl();
    $("refresh-button").disabled = state.restartRequired;
    showError(new Error("Equinox Local did not reconnect after the restart. Refresh to inspect the current runtime state."));
    return;
  }

  state.runtimeRestartTimer = setTimeout(() => {
    void pollRuntimeRestart(previousPid, attempt + 1);
  }, 1_000);
}

async function restartRuntimeFromControlCenter() {
  if (state.restartBusy) return;
  clearError();
  stopRuntimeRestartPolling();
  state.restartBusy = true;
  renderRuntimeRestartControl();
  $("refresh-button").disabled = true;
  const previousPid = state.status?.server?.pid ?? null;
  try {
    const response = await mutationJson("/api/v1/runtime/restart", "POST", {});
    if (response.result?.scheduled !== true) {
      throw new Error("Equinox Local did not confirm the restart schedule.");
    }
    showToast("Equinox Local is restarting safely…");
    state.runtimeRestartTimer = setTimeout(() => {
      void pollRuntimeRestart(previousPid);
    }, 1_200);
  } catch (error) {
    state.restartBusy = false;
    renderRuntimeRestartControl();
    $("refresh-button").disabled = state.restartRequired;
    showError(error);
  }
}

async function saveConfiguration() {
  if (!state.config || !state.dirty || state.restartRequired) return;
  clearError();
  const button = $("save-config-button");
  const accessButton = $("save-agent-access-button");
  button.disabled = true;
  button.textContent = localizeUiText("Saving…");
  if (accessButton) {
    accessButton.disabled = true;
    accessButton.textContent = localizeUiText("Saving…");
  }
  try {
    const session = await requestJson("/api/v1/session");
    const result = await requestJson("/api/v1/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-equinox-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        expectedRevision: state.revision,
        config: state.config,
      }),
    });
    state.revision = result.persistedRevision;
    state.restartRequired = Boolean(result.restartRequired);
    state.dirty = false;
    setBadge("dirty-state", "Saved · restart required", "warn");
    updateRestartState();
    renderActivity();
    showToast("Configuration saved safely.");
  } catch (error) {
    showError(error);
    button.disabled = false;
    if (accessButton) accessButton.disabled = false;
  } finally {
    button.textContent = localizeUiText("Save configuration");
    if (accessButton) {
      accessButton.textContent = localizeUiText("Save access settings");
    }
  }
}

function bindEvents() {
  for (const button of document.querySelectorAll(".nav-item")) {
    button.addEventListener("click", () => switchSection(button.dataset.section));
  }
  for (const button of document.querySelectorAll("[data-jump-section]")) {
    button.addEventListener("click", () => switchSection(button.dataset.jumpSection));
  }

  $("language-select").addEventListener("change", (event) => setLanguage(event.target.value));
  $("restart-runtime-button").addEventListener("click", restartRuntimeFromControlCenter);
  $("refresh-button").addEventListener("click", refreshAll);
  $("onboarding-tunnel-form").addEventListener("submit", submitTunnelOnboarding);
  $("uninstall-form").addEventListener("submit", submitUninstall);
  $("uninstall-confirmation").addEventListener("input", renderUninstall);
  $("uninstall-remove-data").addEventListener("change", renderUninstall);
  $("check-update-button").addEventListener("click", checkForUpdates);
  $("install-update-button").addEventListener("click", applyAvailableUpdate);
  $("dismiss-error").addEventListener("click", clearError);
  $("reload-after-restart").addEventListener("click", () => window.location.reload());
  $("add-project-button").addEventListener("click", () => openRootDialog({ mode: "add", kind: "project" }));
  $("add-folder-button").addEventListener("click", () => openRootDialog({ mode: "add", kind: "fileRoot" }));
  $("close-dialog").addEventListener("click", closeRootDialog);
  $("cancel-dialog").addEventListener("click", closeRootDialog);
  $("root-form").addEventListener("submit", applyRootForm);
  $("choose-folder-button").addEventListener("click", chooseFolderForDialog);
  $("save-config-button").addEventListener("click", saveConfiguration);
  $("save-agent-access-button").addEventListener("click", saveConfiguration);
  $("browser-control-toggle").addEventListener("change", updateBrowserDraftFromInputs);
  $("browser-cursor-toggle").addEventListener("change", updateBrowserDraftFromInputs);
  $("browser-agent-name").addEventListener("input", updateBrowserDraftFromInputs);
  $("apply-browser-settings").addEventListener("click", saveBrowserSettings);

  $("default-project-select").addEventListener("change", (event) => {
    state.config.defaultProject = event.target.value;
    markDirty();
    renderAll();
  });
  $("workspace-project-select").addEventListener("change", (event) => {
    state.config.runtime.workspaceProject = event.target.value;
    markDirty();
    renderAll();
  });
  $("downloads-root-select").addEventListener("change", (event) => {
    state.config.runtime.downloadsRoot = event.target.value;
    markDirty();
    renderAll();
  });

  const updateAgentAccess = () => {
    if (!state.config || state.restartRequired) return;
    state.config.agentAccess = {
      files: $("agent-files-access").value,
      terminal: $("agent-terminal-access").checked,
      desktop: $("agent-desktop-access").checked,
      browser: $("agent-web-access").checked,
    };
    markDirty();
    renderPermissions();
  };
  $("agent-files-access").addEventListener("change", updateAgentAccess);
  $("agent-terminal-access").addEventListener("change", updateAgentAccess);
  $("agent-desktop-access").addEventListener("change", updateAgentAccess);
  $("agent-web-access").addEventListener("change", updateAgentAccess);

  $("root-dialog").addEventListener("click", (event) => {
    if (event.target === $("root-dialog")) closeRootDialog();
  });
}

captureStaticTranslatables();
applyStaticLanguage();
bindEvents();
switchSection(state.activeSection);
renderLastRefreshed();
void refreshAll();
