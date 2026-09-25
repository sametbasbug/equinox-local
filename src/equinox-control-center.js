const $ = (id) => document.getElementById(id);

const LANGUAGE_STORAGE_KEY = "equinox-local-control-center-language";
const THEME_STORAGE_KEY = "equinox-local-control-center-theme";
const SUPPORTED_THEMES = new Set(["system", "light", "dark"]);
const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const SUPPORTED_LANGUAGES = new Set(["en", "tr"]);
const EQUINOX_BROWSER_STORE_URL =
  "https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj";

const TR_UI = Object.freeze({
  "Getting started": "Başlarken",
  "Setup": "Kurulum",
  "Setup Equinox Local": "Equinox Local’i kur",
  "First-time setup": "İlk kurulum",
  "Connect ChatGPT to this Mac": "ChatGPT’yi bu Mac’e bağlayın",
  "Follow these steps once. Control Center unlocks after ChatGPT successfully reaches Equinox Local.": "Bu adımları bir kez tamamlayın. ChatGPT, Equinox Local’e başarıyla ulaştığında Kontrol Merkezi açılır.",
  "Setup in progress": "Kurulum sürüyor",
  "Equinox Local is installed": "Equinox Local kuruldu",
  "The private runtime and starter workspace are already on this Mac.": "Özel runtime ve başlangıç çalışma alanı bu Mac’te hazır.",
  "Create the private OpenAI tunnel": "Özel OpenAI tunnel’ını oluşturun",
  "The Tunnel ID tells ChatGPT which Equinox Local runtime to reach. The Runtime API key lets this Mac connect to that tunnel.": "Tunnel ID, ChatGPT’nin hangi Equinox Local runtime’ına ulaşacağını belirtir. Runtime API anahtarı bu Mac’in tunnel’a bağlanmasını sağlar.",
  "Not connected": "Bağlı değil",
  "Open Tunnels ↗": "Tunnels’ı aç ↗",
  "Open API keys ↗": "API anahtarlarını aç ↗",
  "Use the exact Tunnel ID you will also select in ChatGPT.": "ChatGPT’de de seçeceğiniz aynı Tunnel ID’yi kullanın.",
  "Stored privately on this Mac. Do not use an admin key.": "Bu Mac’te özel olarak saklanır. Admin anahtarı kullanmayın.",
  "Add Equinox Local to ChatGPT": "Equinox Local’i ChatGPT’ye ekleyin",
  "Create or edit the Equinox Local MCP app/connector in ChatGPT and point it at the same tunnel.": "ChatGPT’de Equinox Local MCP uygulamasını/bağlayıcısını oluşturun veya düzenleyin ve aynı tunnel’ı seçin.",
  "Waiting": "Bekliyor",
  "Tunnel ID appears after step 2": "Tunnel ID 2. adımdan sonra görünür",
  "Copy Tunnel ID": "Tunnel ID’yi kopyala",
  "Open ChatGPT settings ↗": "ChatGPT ayarlarını aç ↗",
  "Install Equinox Browser": "Equinox Browser’ı yükleyin",
  "Equinox Browser is a required part of Equinox Local. It provides the browser-side connection and continuity features.": "Equinox Browser, Equinox Local’in zorunlu bir parçasıdır. Tarayıcı tarafı bağlantı ve devamlılık özelliklerini sağlar.",
  "Install Equinox Browser ↗": "Equinox Browser’ı yükle ↗",
  "Waiting for Equinox Browser in Your Browser.": "Kendi tarayıcınızdaki Equinox Browser bekleniyor.",
  "Verify ChatGPT → Mac": "ChatGPT → Mac bağlantısını doğrulayın",
  "Send one real tool request from ChatGPT. Setup stays locked until that request reaches this Mac.": "ChatGPT’den gerçek bir araç isteği gönderin. Bu istek Mac’e ulaşana kadar kurulum kilitli kalır.",
  "Copy test prompt": "Test promptunu kopyala",
  "Waiting for the first Equinox Local tool call from ChatGPT.": "ChatGPT’den ilk Equinox Local araç çağrısı bekleniyor.",
  "Need to remove Equinox Local instead?": "Bunun yerine Equinox Local’i kaldırmak mı istiyorsunuz?",
  "Uninstall": "Kaldır",
  "Connected": "Bağlı",
  "Configure in ChatGPT": "ChatGPT’de yapılandır",
  "Waiting for tunnel": "Tunnel bekleniyor",
  "Verified": "Doğrulandı",
  "Accept disclosure": "Bilgilendirmeyi kabul edin",
  "Enable Browser Control": "Browser Control’u açın",
  "Command received": "Komut alındı",
  "Ready to verify": "Doğrulamaya hazır",
  "Setup complete. ChatGPT can now reach this Mac.": "Kurulum tamamlandı. ChatGPT artık bu Mac’e ulaşabiliyor.",
  "Tunnel ID copied.": "Tunnel ID kopyalandı.",
  "Test prompt copied.": "Test promptu kopyalandı.",
  "Create the tunnel, add Equinox Local to ChatGPT, install Equinox Browser, then verify the first real tool call.": "Tunnel’ı oluşturun, Equinox Local’i ChatGPT’ye ekleyin, Equinox Browser’ı kurun ve ardından ilk gerçek araç çağrısını doğrulayın.",
  "Open OpenAI Tunnels and create a tunnel for this Equinox Local installation.": "OpenAI Tunnels’ı açın ve bu Equinox Local kurulumu için bir tunnel oluşturun.",
  "Copy the new tunnel_… ID.": "Yeni tunnel_… kimliğini kopyalayın.",
  "Open API keys, create a Restricted key, and grant only Tunnels: Read + Use.": "API anahtarlarını açın, Restricted bir anahtar oluşturun ve yalnızca Tunnels: Read + Use izni verin.",
  "Choose Tunnel as the connection type.": "Bağlantı türü olarak Tunnel seçin.",
  "Select or paste the same Tunnel ID shown below, then save the connector.": "Aşağıda gösterilen aynı Tunnel ID’yi seçin veya yapıştırın ve bağlayıcıyı kaydedin.",
  "Install Equinox Browser from Chrome Web Store in the Chrome profile you use with ChatGPT.": "Equinox Browser’ı Chrome Web Store’dan ChatGPT ile kullandığınız Chrome profiline yükleyin.",
  "Turn Browser Control on. This setup screen detects the connection automatically.": "Browser Control’u açın. Bu kurulum ekranı bağlantıyı otomatik algılar.",
  "Paste both values below. The API key stays only on this Mac and is never shown again.": "İki değeri de aşağıya yapıştırın. API anahtarı yalnızca bu Mac’te kalır ve tekrar gösterilmez.",
  "Open ChatGPT connector/app settings and start the custom MCP connection flow available to your account/workspace.": "ChatGPT bağlayıcı/uygulama ayarlarını açın ve hesabınızda/çalışma alanınızda bulunan özel MCP bağlantı akışını başlatın.",
  "Open the extension, review and accept the browser-data disclosure.": "Uzantıyı açın, tarayıcı verisi bilgilendirmesini inceleyip kabul edin.",
  "After the connector and browser extension are ready, paste this into ChatGPT:": "Bağlayıcı ve tarayıcı uzantısı hazır olduğunda bunu ChatGPT’ye yapıştırın:",
  "Install Equinox Browser in Your Browser and open the extension.": "Equinox Browser’ı kendi tarayıcınıza yükleyin ve uzantıyı açın.",
  "Equinox Browser is connected. Review and accept the browser-data disclosure in the extension.": "Equinox Browser bağlı. Uzantıdaki tarayıcı verisi bilgilendirmesini inceleyip kabul edin.",
  "Disclosure accepted. Turn Browser Control on to finish the required browser connection.": "Bilgilendirme kabul edildi. Gerekli tarayıcı bağlantısını tamamlamak için Browser Control’u açın.",
  "Equinox Browser is connected, consented and Browser Control is on.": "Equinox Browser bağlı, bilgilendirme kabul edildi ve Browser Control açık.",
  "Waiting for the first Equinox Local tool call from ChatGPT. This is the final setup check.": "ChatGPT’den ilk Equinox Local araç çağrısı bekleniyor. Bu son kurulum kontrolüdür.",
  "Finish the remaining steps. Setup unlocks only after a real ChatGPT tool request reaches this Mac.": "Kalan adımları tamamlayın. Kurulum ancak ChatGPT’den gerçek bir araç isteği bu Mac’e ulaştığında açılır.",
  "Tunnel settings are saved. Equinox Local is reconnecting through your private tunnel.": "Tunnel ayarları kaydedildi. Equinox Local özel tunnel üzerinden yeniden bağlanıyor.",
  "The saved tunnel connection needs attention. Re-enter the Runtime API key to repair it.": "Kayıtlı tunnel bağlantısının ilgilenilmesi gerekiyor. Düzeltmek için Runtime API anahtarını yeniden girin.",
  "OpenAI Tunnels": "OpenAI Tunnels",
  "API keys": "API anahtarları",
  "Restricted": "Restricted",
  "Tunnel": "Tunnel",
  "Equinox Browser": "Equinox Browser",
  "Browser Control": "Browser Control",
  "Your local runtime is ready. Add the OpenAI tunnel credentials to finish connecting Equinox Local to ChatGPT.": "Yerel runtime hazır. Equinox Local’i ChatGPT’ye bağlamak için OpenAI tunnel bilgilerini ekleyin.",
  "Tunnel settings are saved. Equinox Local is switching from local-only setup mode to the private ChatGPT connection.": "Tunnel ayarları kaydedildi. Equinox Local, yerel kurulum modundan özel ChatGPT bağlantısına geçiyor.",
  "The saved tunnel connection needs attention. Re-enter the Runtime API key to repair it.": "Kaydedilmiş tunnel bağlantısı kontrol edilmeli. Onarmak için Runtime API anahtarını yeniden girin.",
  "Skip to content": "İçeriğe geç",
  "Workspace": "Çalışma alanı",
  "Your workspace": "Çalışma alanınız",
  "Your Mac, connected": "Mac’iniz, bağlantıda",
  "Connected capabilities": "Bağlı araçlar",
  "On this Mac": "Bu Mac’te",
  "ChatGPT to Mac connection": "ChatGPT ile Mac bağlantısı",
  "ChatGPT on the web": "ChatGPT web",
  "Tools on this Mac": "Mac’inizdeki araçlar",
  "Checking connection": "Bağlantı kontrol ediliyor",
  "ChatGPT connected": "ChatGPT bağlantısı açık",
  "ChatGPT not connected": "ChatGPT bağlı değil",
  "Connection needs attention": "Bağlantı kontrol edilmeli",
  "Connection status unavailable": "Bağlantı durumu alınamadı",
  "MCP runtime connected": "MCP runtime bağlı",
  "Desktop": "Masaüstü",
  "Local connection": "Yerel bağlantı",
  "Open Browser settings": "Tarayıcı ayarlarını aç",
  "Open Services": "Servisleri aç",
  "View all checks": "Tüm kontrolleri göster",
  "Doctor → Fix": "Doctor → Fix",
  "Checking recent diagnosed incidents for safe predefined fixes.": "Güvenli, önceden tanımlı düzeltmeler için son teşhis edilen olaylar kontrol ediliyor.",
  "No active repairable incidents were diagnosed.": "Düzeltilebilir aktif bir olay teşhis edilmedi.",
  "Safe fixes available": "Güvenli düzeltmeler hazır",
  "No fixes needed": "Düzeltme gerekmiyor",
  "Fix safely": "Güvenli düzelt",
  "Repair running…": "Düzeltme çalışıyor…",
  "Restart Peekaboo bridge": "Peekaboo köprüsünü yeniden başlat",
  "Clean stale preview": "Takılı preview sürecini temizle",
  "Clean workflow orphan processes": "Workflow yetim süreçlerini temizle",
  "Resume resumable workflow": "Sürdürülebilir workflow'u devam ettir",
  "Doctor fix verified.": "Doctor düzeltmesi doğrulandı.",
  "Doctor fix completed but the incident still needs attention.": "Doctor düzeltmesi tamamlandı ancak olay hâlâ ilgi gerektiriyor.",
  "Choose a profile. Its settings stay separate.": "Bir profil seçin. Her profilin ayarları ayrı tutulur.",
  "Configured folder scope": "Yapılandırılmış klasör kapsamı",
  "Named projects and read-only folders used by structured capabilities.": "Yapılandırılmış araçların kullandığı adlandırılmış projeler ve salt okunur klasörler.",
  "Keep named shortcuts to your projects and folders. These settings do not limit Terminal access.": "Proje ve klasörlerinize adlandırılmış kısayollar ekleyin. Bu ayarlar Terminal erişimini sınırlamaz.",
  "Your named projects and folders, saved privately on this Mac.": "Bu Mac’te özel olarak saklanan proje ve klasör kısayollarınız.",
  "Access settings": "Erişim ayarları",
  "Review recent runtime events and configuration changes. Sensitive details are kept out of this timeline.": "Son çalışma olaylarını ve yapılandırma değişikliklerini inceleyin. Hassas ayrıntılar bu akışta gösterilmez.",
  "Recent activity": "Son etkinlikler",
  "Connect the tools your agent needs. Optional services can be unavailable without stopping local execution.": "Ajanınızın ihtiyaç duyduğu araçları bağlayın. İsteğe bağlı bir servis kullanılamasa da yerel çalıştırma devam eder.",
  "Save your changes, then restart Equinox Local to apply them.": "Değişikliklerinizi kaydedin, ardından uygulamak için Equinox Local’i yeniden başlatın.",
  "Stored privately on this Mac. Your key is never shown again.": "Bu Mac’te özel olarak saklanır. Anahtarınız tekrar gösterilmez.",
  "Additional folders are read-only. This screen cannot grant write access.": "Ek klasörler salt okunurdur. Bu ekrandan yazma izni verilemez.",
  "If Agent Browser is unavailable, the task stops. Equinox Local never switches to your personal Chrome without an explicit choice.": "Agent Browser kullanılamıyorsa görev durur. Equinox Local, açık bir seçim olmadan kişisel Chrome’unuza geçmez.",
  "Agent paused": "Ajan duraklatıldı",
  "New actions are blocked. Read-only status is still available. Use Resume agent to continue.": "Yeni işlemler engellendi. Salt okunur durum bilgisi erişilebilir. Devam etmek için Ajanı sürdür düğmesini kullanın.",
  "Your agent is paused": "Ajanınız duraklatıldı",
  "Local stays connected for read-only status. Resume when you are ready; stopped work will not restart on its own.": "Yerel bağlantı, salt okunur durum bilgisi için açık kalır. Hazır olduğunuzda sürdürün; durdurulan işler kendiliğinden yeniden başlamaz.",
  "Your Mac is ready": "Mac’iniz hazır",
  "Local tools are ready. Your agent stays in ChatGPT on the web; its connected tools run here on your Mac.": "Yerel araçlar hazır. Ajanınız ChatGPT web’de kalır; bağlı araçları burada, Mac’inizde çalışır.",
  "Equinox Local Control Center": "Equinox Local Kontrol Merkezi",
  "Primary navigation": "Ana gezinme",
  "Control Center": "Kontrol Merkezi",
  "Control Center sections": "Kontrol Merkezi bölümleri",
  "Dashboard": "Gösterge Paneli",
  "Projects & folders": "Projeler ve klasörler",
  "Tasks": "Görevler",
  "Recent tasks": "Son görevler",
  "Select a task": "Bir görev seçin",
  "Choose a task on the left to inspect its latest checkpoint.": "Son checkpoint’i incelemek için soldan bir görev seçin.",
  "Task Capsule": "Görev Kapsülü",
  "Auto Continue": "Otomatik Devam",
  "Turn safety": "Tur güvenliği",
  "Turn Budget": "Tur Bütçesi",
  "Tracks the current assistant turn from its first Equinox Local use and warns before the safety cutoff.": "Mevcut asistan turunu ilk Equinox Local kullanımından itibaren izler ve güvenlik süresi dolmadan önce uyarır.",
  "Elapsed": "Geçen",
  "Remaining": "Kalan",
  "Stage": "Aşama",
  "Idle": "Beklemede",
  "Enable Turn Budget": "Tur Bütçesini etkinleştir",
  "Warn the agent before the per-turn safety cutoff. This never force-stops a turn.": "Tur başına güvenlik süresi dolmadan önce ajanı uyarır. Turu hiçbir zaman zorla durdurmaz.",
  "Safety cutoff (minutes)": "Güvenlik süresi (dakika)",
  "Default 22 minutes. The setting applies immediately and does not require a Local restart.": "Varsayılan 22 dakika. Ayar anında uygulanır ve Local yeniden başlatma gerektirmez.",
  "Save Turn Budget": "Tur Bütçesini kaydet",
  "Off": "Kapalı",
  "Disabled": "Devre dışı",
  "Running": "Çalışıyor",
  "Checkpoint soon": "Checkpoint yaklaşıyor",
  "Finalizing": "Final hazırlanıyor",
  "Cutoff reached": "Güvenlik süresi doldu",
  "Turn Budget is disabled. Equinox Local will not add per-turn finalization guidance.": "Tur Bütçesi devre dışı. Equinox Local tur sonlandırma yönlendirmesi eklemeyecek.",
  "Waiting for the first Equinox Local call in an assistant turn.": "Asistan turundaki ilk Equinox Local çağrısı bekleniyor.",
  "Bound to the current ChatGPT assistant turn through Equinox Browser.": "Equinox Browser üzerinden mevcut ChatGPT asistan turuna bağlı.",
  "Using first-Local-call fallback because browser turn identity is unavailable.": "Tarayıcı tur kimliği kullanılamadığı için ilk Local çağrısı fallback'i kullanılıyor.",
  "Turn Budget updated immediately.": "Tur Bütçesi anında güncellendi.",
  "Not armed": "Kurulu değil",
  "Waiting": "Bekliyor",
  "Delivering": "Gönderiliyor",
  "Delivered": "Gönderildi",
  "Failed": "Başarısız",
  "Expired": "Süresi doldu",
  "Cancelled": "İptal edildi",
  "Completed": "Tamamlandı",
  "Completed items": "Tamamlananlar",
  "No browser target": "Tarayıcı hedefi yok",
  "Title": "Başlık",
  "Objective": "Amaç",
  "Next": "Sıradaki",
  "References": "Referanslar",
  "One completed item per line": "Her satıra bir tamamlanan madde",
  "One next step per line": "Her satıra bir sonraki adım",
  "One safe reference per line: project, branch, commit, file, url or note.": "Her satıra bir güvenli referans: project, branch, commit, file, url veya note.",
  "Save changes": "Değişiklikleri kaydet",
  "Cancel continuation": "Otomatik devamı iptal et",
  "Mark complete": "Tamamlandı olarak işaretle",
  "Cancel task": "Görevi iptal et",
  "Delete task": "Görevi sil",
  "This task is terminal and can no longer be edited.": "Bu görev terminal durumda ve artık düzenlenemez.",
  "Inspect durable task checkpoints and take control when an automatic continuation should stop or change. Task state stays private on this Mac.": "Kalıcı görev checkpoint’lerini inceleyin; otomatik devamın durması veya değişmesi gerektiğinde kontrolü alın. Görev durumu bu Mac’te özel kalır.",
  "Task changes saved.": "Görev değişiklikleri kaydedildi.",
  "Continuation cancelled.": "Otomatik devam iptal edildi.",
  "Task marked complete.": "Görev tamamlandı olarak işaretlendi.",
  "Task cancelled.": "Görev iptal edildi.",
  "Task deleted.": "Görev silindi.",
  "Mark this task complete?": "Bu görevi tamamlandı olarak işaretlemek istiyor musunuz?",
  "Cancel this task?": "Bu görevi iptal etmek istiyor musunuz?",
  "Delete this task permanently? This cannot be undone.": "Bu görevi kalıcı olarak silmek istiyor musunuz? Bu işlem geri alınamaz.",
  "No Task Capsules yet. Tasks appear here after an agent saves a checkpoint.": "Henüz Görev Kapsülü yok. Bir ajan checkpoint kaydettiğinde görevler burada görünür.",
  "Task recovery": "Görev kurtarma",
  "Needs attention": "İlgi gerekiyor",
  "Recoverable": "Kurtarılabilir",
  "In progress": "Devam ediyor",
  "Fresh-chat handoff is waiting": "Yeni sohbet aktarımı bekliyor",
  "Fresh-chat handoff is in progress": "Yeni sohbet aktarımı devam ediyor",
  "Fresh-chat handoff needs attention": "Yeni sohbet aktarımı ilgi gerektiriyor",
  "Fresh-chat handoff stopped": "Yeni sohbet aktarımı durdu",
  "Cancel fresh-chat handoff": "Yeni sohbet aktarımını iptal et",
  "Clear blocked transition": "Takılı geçişi temizle",
  "Fresh-chat handoff cancelled.": "Yeni sohbet aktarımı iptal edildi.",
  "Blocked transition cleared. Continue from the saved checkpoint in ChatGPT.": "Takılı geçiş temizlendi. ChatGPT'de kayıtlı checkpoint'ten devam edin.",
  "Clear this blocked fresh-chat transition? This does not retry the browser action.": "Bu takılı yeni sohbet geçişi temizlensin mi? Bu işlem tarayıcı eylemini yeniden denemez.",
  "Equinox will move this task after the current assistant turn finishes. You can cancel the handoff before browser mutation starts.": "Equinox mevcut asistan turu bittikten sonra bu görevi taşıyacak. Tarayıcı değişikliği başlamadan aktarımı iptal edebilirsiniz.",
  "Browser mutation has started. Equinox will not start another handoff while this transition is unresolved. Use Emergency Stop if you need to interrupt it.": "Tarayıcı değişikliği başladı. Bu geçiş çözülmeden Equinox başka bir aktarım başlatmaz. Müdahale etmeniz gerekirse Emergency Stop kullanın.",
  "The fresh-chat handoff became uncertain after browser mutation started. Equinox will not retry it automatically.": "Tarayıcı değişikliği başladıktan sonra yeni sohbet aktarımı belirsiz hale geldi. Equinox bunu otomatik olarak yeniden denemez.",
  "The browser handoff could not be confirmed. Equinox will not retry it automatically.": "Tarayıcı aktarımı doğrulanamadı. Equinox bunu otomatik olarak yeniden denemez.",
  "Equinox restarted after browser mutation started, so the handoff could not be proven. It will not retry automatically.": "Tarayıcı değişikliği başladıktan sonra Equinox yeniden başlatıldı; bu yüzden aktarım doğrulanamadı. Otomatik olarak yeniden denenmez.",
  "Emergency Stop interrupted the handoff after browser mutation started. Equinox will not retry it automatically.": "Emergency Stop, tarayıcı değişikliği başladıktan sonra aktarımı kesti. Equinox bunu otomatik olarak yeniden denemez.",
  "A safety guard stopped the handoff after browser mutation started. Equinox will not retry it automatically.": "Bir güvenlik koruması, tarayıcı değişikliği başladıktan sonra aktarımı durdurdu. Equinox bunu otomatik olarak yeniden denemez.",
  "Emergency Stop cancelled the handoff before browser mutation. The saved checkpoint is still available.": "Emergency Stop, tarayıcı değişikliğinden önce aktarımı iptal etti. Kayıtlı checkpoint hâlâ kullanılabilir.",
  "The fresh-chat handoff was cancelled before browser mutation. The saved checkpoint is still available.": "Yeni sohbet aktarımı tarayıcı değişikliğinden önce iptal edildi. Kayıtlı checkpoint hâlâ kullanılabilir.",
  "The task checkpoint changed, so the pending fresh-chat handoff was cancelled. The latest checkpoint is ready to continue.": "Görev checkpoint'i değiştiği için bekleyen yeni sohbet aktarımı iptal edildi. En güncel checkpoint devam etmeye hazır.",
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
  "Browser contexts": "Tarayıcı bağlamları",
  "Agent Browser": "Agent Browser",
  "Your Browser": "Tarayıcınız",
  "Isolation": "İzolasyon",
  "Dedicated Chrome profile": "Özel Chrome profili",
  "Open Agent Browser": "Agent Browser'ı aç",
  "Opening…": "Açılıyor…",
  "Agent Browser is open": "Agent Browser açık",
  "Settings target": "Ayar hedefi",
  "Settings are stored independently in each Chrome profile.": "Ayarlar her Chrome profilinde birbirinden bağımsız saklanır.",
  "No silent browser fallback": "Sessiz tarayıcı fallback'i yok",
  "Setup needed": "Kurulum gerekli",
  "Closed": "Kapalı",
  "Waiting for extension": "Uzantı bekleniyor",
  "Agent Browser · isolated default": "Agent Browser · izole varsayılan",
  "Agent Browser is ready and is the default target for browser automation.": "Agent Browser hazır ve tarayıcı otomasyonunun varsayılan hedefi.",
  "Agent Browser setup is complete and the isolated browser is currently closed. It will open automatically when an agent needs it.": "Agent Browser kurulumu tamamlandı ve izole tarayıcı şu anda kapalı. Bir ajan ihtiyaç duyduğunda otomatik olarak açılacak.",
  "Open Agent Browser to manage settings for the already configured isolated profile.": "Yapılandırılmış izole profilin ayarlarını yönetmek için Agent Browser’ı açın.",
  "Waiting for Equinox Browser to connect from the isolated Agent Browser profile.": "Equinox Browser'ın izole Agent Browser profilinden bağlanması bekleniyor.",
  "Equinox Browser is connected in Agent Browser, but browser automation is turned off in that profile.": "Equinox Browser Agent Browser'a bağlı, ancak bu profilde tarayıcı otomasyonu kapalı.",
  "Open the Equinox Browser popup in Agent Browser, review the data-use disclosure, and enable browser control there.": "Agent Browser içinde Equinox Browser açılır penceresini açın, veri kullanımı açıklamasını inceleyin ve tarayıcı kontrolünü oradan etkinleştirin.",
  "Open the Equinox Browser popup in the selected profile, review the data-use disclosure, and enable browser control there.": "Seçili profilde Equinox Browser açılır penceresini açın, veri kullanımı açıklamasını inceleyin ve tarayıcı kontrolünü oradan etkinleştirin.",
  "Open Agent Browser and install Equinox Browser in that isolated profile to manage its settings.": "Ayarlarını yönetmek için Agent Browser'ı açın ve Equinox Browser'ı bu izole profile kurun.",
  "Connect Equinox Browser in Your Browser to manage its settings from Control Center.": "Ayarlarını Control Center'dan yönetmek için Tarayıcınızda Equinox Browser'ı bağlayın.",
  "Agent Browser opened.": "Agent Browser açıldı.",
  "Equinox Local keeps the agent's isolated Agent Browser separate from your personal Chrome. Both use the same Equinox Browser extension and Native Messaging capability set.": "Equinox Local, ajanın izole Agent Browser'ını kişisel Chrome'unuzdan ayrı tutar. İkisi de aynı Equinox Browser uzantısını ve Native Messaging yetenek setini kullanır.",
  "The default automation target. It uses a dedicated Chrome profile that stays isolated from your personal browser data and sessions.": "Varsayılan otomasyon hedefidir. Kişisel tarayıcı verilerinizden ve oturumlarınızdan ayrı kalan özel bir Chrome profili kullanır.",
  "Your personal Chrome profile. Agents use it only when the task explicitly requires your existing browser sessions or accounts.": "Kişisel Chrome profilinizdir. Ajanlar bunu yalnızca görev mevcut tarayıcı oturumlarınızı veya hesaplarınızı açıkça gerektirdiğinde kullanır.",
  "On first use, Agent Browser opens Chrome Web Store inside the isolated profile so Equinox Browser can be installed there.": "İlk kullanımda Agent Browser, Equinox Browser'ın izole profile kurulabilmesi için Chrome Web Store'u bu profilin içinde açar.",
  "Agent access": "Ajan erişimi",
  "Equinox Local starts new installations with broad useful access. Narrow these controls when you want the agent contained to selected roots or without local execution.": "Equinox Local yeni kurulumları geniş ve kullanışlı erişimle başlatır. Ajanı seçili köklerle sınırlamak veya yerel çalıştırmayı kapatmak istediğinizde bu kontrolleri daraltın.",
  "Local capabilities": "Yerel yetenekler",
  "Agent Access": "Ajan Erişimi",
  "Structured roots": "Yapılandırılmış kökler",
  "Full access": "Tam erişim",
  "Selected roots only": "Yalnızca seçili kökler",
  "Controls root-aware project/asset and file-backed special capabilities. Full accepts configured IDs, home, or an accessible absolute folder path; Selected stays on configured roots. Ordinary file, Git and package-manager work uses Terminal.": "Kök duyarlı proje/varlık ve dosya destekli özel yetenekleri denetler. Tam erişim yapılandırılmış kimlikleri, home kökünü veya erişilebilir mutlak klasör yolunu kabul eder; Seçili mod yapılandırılmış köklerde kalır. Normal dosya, Git ve paket yöneticisi işleri Terminal kullanır.",
  "Terminal & processes": "Terminal ve süreçler",
  "Allow shell commands, interactive shells and managed background processes with your normal macOS user permissions. Terminal commands wait for a bounded foreground window; unfinished work continues as the same managed process instead of being restarted. Terminal is not confined to Selected roots after a shell starts; turn it off if you require strict selected-root containment. Equinox-managed provider credentials are not injected into generic shells or processes.": "Normal macOS kullanıcı izinlerinizle kabuk komutlarına, etkileşimli kabuklara ve yönetilen arka plan süreçlerine izin verin. Terminal komutları sınırlı bir ön-plan bekleme penceresi kullanır; bitmeyen iş yeniden başlatılmadan aynı yönetilen süreç olarak devam eder. Bir kabuk başladıktan sonra Terminal Seçili köklerle sınırlı değildir; katı seçili-kök sınırı gerekiyorsa Terminal'i kapatın. Equinox tarafından yönetilen sağlayıcı kimlik bilgileri genel kabuklara veya süreçlere aktarılmaz.",
  "Desktop automation": "Masaüstü otomasyonu",
  "Allow the first-party desktop tool surface when macOS permissions are also granted.": "macOS izinleri de verilmişse birinci taraf masaüstü araç yüzeyine izin verin.",
  "Allow the Equinox Browser lane. Extension consent remains required and cannot be bypassed here.": "Equinox Browser hattına izin verin. Uzantı onayı gerekli kalır ve buradan atlanamaz.",
  "Save access settings": "Erişim ayarlarını kaydet",
  "Access changes use the validated configuration path and require a Local restart.": "Erişim değişiklikleri doğrulanmış yapılandırma yolunu kullanır ve Local'in yeniden başlatılmasını gerektirir.",
  "Maximum useful access": "Maksimum kullanışlı erişim",
  "Restricted access": "Sınırlı erişim",
  "Agent control": "Ajan kontrolü",
  "Safety & access": "Güvenlik ve erişim",
  "Local execution is Equinox Local's core path. Pause the agent instantly when needed, and keep Browser/Desktop permissions separate from advanced structured-file restrictions.": "Yerel çalıştırma Equinox Local'in temel yoludur. Gerektiğinde ajanı anında duraklatın; Browser/Masaüstü izinlarını gelişmiş yapılandırılmış-dosya kısıtlarından ayrı tutun.",
  "Emergency stop": "Acil durdur",
  "Resume agent": "Ajanı sürdür",
  "Stopping agent…": "Ajan durduruluyor…",
  "Resuming agent…": "Ajan sürdürülüyor…",
  "Immediate control": "Anlık kontrol",
  "Agent state": "Ajan durumu",
  "Active": "Aktif",
  "Paused": "Duraklatıldı",
  "Agent mutations are paused. Read-only status remains available until you resume.": "Ajanın değişiklik yapan işlemleri duraklatıldı. Siz sürdürünceye kadar salt-okunur durum erişimi açık kalır.",
  "Agent mutations are active. Emergency Stop is available from the top bar at any time.": "Ajanın değişiklik yapan işlemleri aktif. Acil Durdur düğmesine üst çubuktan her zaman erişebilirsiniz.",
  "Terminal sessions": "Terminal oturumları",
  "Managed processes": "Yönetilen süreçler",
  "Total active work": "Toplam aktif iş",
  "Capability boundaries": "Yetenek sınırları",
  "Local execution": "Yerel çalıştırma",
  "Terminal-first": "Terminal-first",
  "Restricted mode": "Kısıtlı mod",
  "Core · enabled": "Temel · etkin",
  "Disabled": "Devre dışı",
  "Advanced restricted mode": "Gelişmiş kısıtlı mod",
  "Structured file scope": "Yapılandırılmış dosya kapsamı",
  "Open paths (recommended)": "Açık yollar (önerilen)",
  "Configured roots only": "Yalnızca yapılandırılmış kökler",
  "Checking whether the agent is active or paused.": "Ajanın aktif mi duraklatılmış mı olduğu kontrol ediliyor.",
  "Active managed work": "Aktif yönetilen işler",
  "Emergency Stop immediately blocks new mutating agent actions and safely stops Equinox Local-managed Terminal/process work. The MCP connection and read-only status stay alive so the agent can observe the pause and finish its response. Resume never restarts stopped work automatically.": "Acil Durdur, yeni değişiklik yapan ajan eylemlerini anında engeller ve Equinox Local tarafından yönetilen Terminal/süreç işlerini güvenle durdurur. MCP bağlantısı ve salt-okunur durum açık kalır; böylece ajan duraklatmayı fark edip yanıtını tamamlayabilir. Sürdür, durdurulan işleri hiçbir zaman otomatik yeniden başlatmaz.",
  "Capability boundaries": "Yetenek sınırları",
  "Agent Access": "Ajan Erişimi",
  "Terminal/process execution is the core terminal-first capability and uses your normal macOS user permissions. Structured folder scope does not sandbox a running shell.": "Terminal/süreç çalıştırma temel terminal-first yeteneğidir ve normal macOS kullanıcı izinlarınızı kullanır. Yapılandırılmış klasör kapsamı çalışan bir shell'i sandbox içine almaz.",
  "Allow the first-party desktop tool surface when macOS permissions are also granted.": "macOS izinleri de verildiğinde birinci taraf masaüstü araç yüzeyine izin verin.",
  "These controls exist for specialized containment and legacy configurations. They are not a sandbox for Terminal.": "Bu kontroller özel kısıtlama ihtiyaçları ve eski yapılandırmalar için korunur. Terminal için bir sandbox değildir.",
  "Applies only to root-aware structured capabilities such as project discovery and image viewing. Terminal uses the logged-in macOS user's permissions.": "Yalnızca proje keşfi ve görsel görüntüleme gibi kök-farkındalıklı yapılandırılmış yeteneklere uygulanır. Terminal oturum açmış macOS kullanıcısının izinlarını kullanır.",
  "Turning this off disables Terminal, interactive shells and managed processes. Equinox Local becomes heavily restricted and many agent tasks will no longer work.": "Bunu kapatmak Terminal'i, etkileşimli shell'leri ve yönetilen süreçleri devre dışı bırakır. Equinox Local ciddi biçimde kısıtlanır ve birçok ajan görevi artık çalışmaz.",
  "Browser/Desktop and advanced access changes use the validated configuration path and require a Local restart. Emergency Stop/Resume apply immediately and do not edit configuration.": "Tarayıcı/Masaüstü ve gelişmiş erişim değişiklikleri doğrulanmış yapılandırma yolunu kullanır ve Local'in yeniden başlatılmasını gerektirir. Acil Durdur/Sürdür anında uygulanır ve yapılandırmayı değiştirmez.",
  "Agent resumed.": "Ajan sürdürüldü.",
  "Emergency Stop activated. Agent mutations are paused.": "Acil Durdur etkinleştirildi. Ajanın değişiklik yapan işlemleri duraklatıldı.",
  "Structured shortcut": "Yapılandırılmış kısayol",
  "Structured scope": "Yapılandırılmış kapsam",
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
  "Optional integrations fail independently. Equinox Browser is required for the supported managed product path; Desktop and other optional integrations remain isolated.": "İsteğe bağlı entegrasyonlar birbirinden bağımsız hata verir. Desteklenen yönetilen ürün akışında Equinox Browser zorunludur; Masaüstü ve diğer isteğe bağlı entegrasyonlar bağımsız kalır.",
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
  "Web file transfer": "Web dosya aktarımı",
  "Files sent from ChatGPT to this Mac are saved here by default. Explicit destinations still override this folder.": "ChatGPT’den bu Mac’e gönderilen dosyalar varsayılan olarak buraya kaydedilir. Açıkça belirtilen hedef klasörler bu ayarı geçersiz kılar.",
  "Web file transfer folder updated.": "Web dosya aktarım klasörü güncellendi.",
  "Web file transfer folder reset to default.": "Web dosya aktarım klasörü varsayılana döndürüldü.",
  "Download folder": "İndirme klasörü",
  "Change folder…": "Klasörü değiştir…",
  "Reset to default": "Varsayılana dön",
  "Incoming Telegram photos and documents are saved here. Changing this affects only new files; existing task attachments stay where they are. Files in this user-visible folder are not auto-deleted.": "Telegram’dan gelen fotoğraf ve belgeler buraya kaydedilir. Bu ayarı değiştirmek yalnızca yeni dosyaları etkiler; mevcut görev ekleri bulundukları yerde kalır. Kullanıcıya görünür bu klasördeki dosyalar otomatik silinmez.",
  "Telegram download folder updated.": "Telegram indirme klasörü güncellendi.",
  "Telegram download folder reset to default.": "Telegram indirme klasörü varsayılana döndürüldü.",
  "Choosing…": "Seçiliyor…",
  "Use the macOS folder picker or enter an absolute path manually. Equinox Local validates the selection and never grants the filesystem root.": "macOS klasör seçicisini kullanın veya mutlak yolu elle girin. Equinox Local seçimi doğrular ve dosya sisteminin kökünü hiçbir zaman açmaz.",
  "Managed worktrees": "Yönetilen worktree'ler",
  "Include this project in Equinox Local managed-worktree maintenance and cleanup tracking.": "Bu projeyi Equinox Local yönetilen-worktree bakım ve temizlik takibine dahil edin.",
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
  "Equinox Local checked the runtime, private configuration, update path, Equinox Browser and optional integrations without exposing local paths or secrets.": "Equinox Local yerel yolları veya gizli değerleri açığa çıkarmadan runtime'ı, özel yapılandırmayı, güncelleme yolunu, Equinox Browser'ı ve isteğe bağlı entegrasyonları kontrol etti.",
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
  "Root-aware structured tools stay contained to this configured root.": "Kök duyarlı yapılandırılmış araçlar bu yapılandırılmış kök içinde kalır.",
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
  "Root-aware structured tools stay contained to this configured root. Granular per-tool capability switches are not part of config schema V1 yet.": "Kök duyarlı yapılandırılmış araçlar bu yapılandırılmış kök içinde kalır. Araç başına ayrıntılı yetenek anahtarları henüz V1 yapılandırma şemasının parçası değildir.",
  "This extra file root is intentionally read-only in V1 and cannot be promoted to writable from the Control Center.": "Bu ek dosya kökü V1'de bilinçli olarak salt okunurdur ve Kontrol Merkezi'nden yazılabilir duruma yükseltilemez.",
  "Stopping": "Durduruluyor",
  "Deletes user data": "Kullanıcı verilerini siler",
  "Preserves user data": "Kullanıcı verilerini korur",
  "Uninstall scheduled": "Kaldırma planlandı",
  "Scheduling uninstall…": "Kaldırma planlanıyor…",
  "Uninstall & delete local data": "Kaldır ve yerel verileri sil",
  "Telegram": "Telegram",
  "Connect Telegram": "Telegram’ı bağlayın",
  "Recommended": "Önerilen",
  "Pairing": "Eşleştiriliyor",
  "Confirm account": "Hesabı doğrulayın",
  "Skipped": "Atlandı",
  "Pair Telegram": "Telegram’ı eşleştir",
  "Pair this account": "Bu hesabı eşleştir",
  "Cancel pairing": "Eşleştirmeyi iptal et",
  "Open BotFather ↗": "BotFather’ı aç ↗",
  "Open your bot ↗": "Botunu aç ↗",
  "Skip for now": "Şimdilik geç",
  "Starting pairing…": "Eşleştirme başlatılıyor…",
  "Telegram pairing started. Send /start to your bot.": "Telegram eşleştirmesi başladı. Botuna /start gönder.",
  "Telegram paired successfully.": "Telegram başarıyla eşleştirildi.",
  "Telegram pairing cancelled.": "Telegram eşleştirmesi iptal edildi.",
  "Pair a Telegram bot to one private account. No Telegram user ID is required.": "Bir Telegram botunu tek bir özel hesaba eşleştirin. Telegram kullanıcı ID’si gerekmez.",
  "Create a bot with BotFather using /newbot, copy its HTTP API token, then start pairing here. You will confirm the detected private account before Equinox Local saves it.": "BotFather’da /newbot ile bir bot oluşturun, HTTP API tokenını kopyalayın ve eşleştirmeyi buradan başlatın. Equinox Local kaydetmeden önce algılanan özel hesabı siz doğrulayacaksınız.",
  "The token stays only on this Mac. Telegram user ID is discovered during pairing.": "Token yalnızca bu Mac’te kalır. Telegram kullanıcı ID’si eşleştirme sırasında otomatik bulunur.",
  "Recommended. Telegram lets Equinox Local reach you away from the Mac and will become the remote task inbox for agent replies and controls.": "Önerilen. Telegram, Mac’in başında değilken Equinox Local’in size ulaşmasını sağlar ve ajan yanıtları ile kontrolleri için uzaktan görev gelen kutusu olacaktır.",
  "Open BotFather in Telegram and send /newbot.": "Telegram’da BotFather’ı açın ve /newbot gönderin.",
  "Choose a display name and a unique bot username when BotFather asks.": "BotFather istediğinde görünen bir ad ve benzersiz bir bot kullanıcı adı seçin.",
  "Copy the HTTP API token BotFather gives you and paste it below.": "BotFather’ın verdiği HTTP API tokenını kopyalayıp aşağıya yapıştırın.",
  "Choose Pair Telegram, open your new bot, and send /start.": "Telegram’ı eşleştir’i seçin, yeni botunuzu açın ve /start gönderin.",
  "Equinox Local will show the detected private account here. Confirm it before anything is saved.": "Equinox Local algılanan özel hesabı burada gösterecek. Herhangi bir şey kaydedilmeden önce hesabı doğrulayın.",
  "The token stays only on this Mac. Do not share it with the agent or paste it into chat.": "Token yalnızca bu Mac’te kalır. Ajanla paylaşmayın veya sohbete yapıştırmayın.",
  "Waiting for /start from your bot chat.": "Bot sohbetinizden /start bekleniyor.",
  "Skipped for now. Telegram remains available later in Control Center → Services.": "Şimdilik atlandı. Telegram daha sonra Kontrol Merkezi → Servisler bölümünden bağlanabilir.",
  "Saved Telegram credentials need attention. Reconnect the bot to replace them safely.": "Kaydedilmiş Telegram kimlik bilgileri dikkat gerektiriyor. Güvenle değiştirmek için botu yeniden bağlayın.",
  "Connect a Telegram bot to one Telegram account. Groups and channels are not supported, and agents cannot choose another recipient.": "Bir Telegram botunu tek bir Telegram hesabına bağlayın. Gruplar ve kanallar desteklenmez; ajanlar başka bir alıcı seçemez.",
  "Send test": "Test gönder",
  "Disconnect": "Bağlantıyı kes",
  "Bot token": "Bot tokenı",
  "Consent required": "Onay gerekli",
  "Automation off": "Otomasyon kapalı",
  "Browser settings": "Tarayıcı ayarları",
  "Install extension": "Uzantıyı yükle",
  "Chrome Web Store": "Chrome Web Store",
  "Peekaboo desktop bridge": "Peekaboo masaüstü köprüsü",
  "First-party Chrome bridge through the extension and Native Messaging.": "Uzantı ve Native Messaging üzerinden birinci taraf Chrome köprüsü.",
  "Optional macOS desktop capability. It is not required for Terminal, GitHub or Browser operations.": "İsteğe bağlı macOS masaüstü yeteneği. Terminal, GitHub veya Tarayıcı işlemleri için gerekli değildir.",
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
  "Telegram remote control": "Telegram uzaktan kontrolü",
  "Allow the paired Telegram account to control Tasks, Chat Bridge and Local controls. Turning this off ignores and discards inbound Telegram commands/messages while outbound notifications remain available.": "Eşleştirilmiş Telegram hesabının Task'ları, Chat Bridge'i ve Local kontrollerini yönetmesine izin ver. Bunu kapatmak gelen Telegram komut ve mesajlarını yok sayıp siler; giden bildirimler kullanılabilir kalır.",
  "Telegram remote control enabled.": "Telegram uzaktan kontrolü açıldı.",
  "Telegram remote control disabled.": "Telegram uzaktan kontrolü kapatıldı.",
  "Telegram disconnected.": "Telegram bağlantısı kesildi.",
  "Authenticated HTTP profiles": "Kimlik doğrulamalı HTTP profilleri",
  "Keep API credentials on this Mac while allowing agents to make bounded requests only to the HTTPS origins, methods and paths you approve.": "API kimlik bilgilerini bu Mac’te tutarken ajanların yalnızca onayladığınız HTTPS origin, yöntem ve yollara sınırlı istekler göndermesine izin verin.",
  "Allow agents to manage HTTP profiles": "Ajanların HTTP profillerini yönetmesine izin ver",
  "Agents may create, edit and delete profile structure. Credentials remain human-only and are never exposed to the agent.": "Ajanlar profil yapısını oluşturabilir, düzenleyebilir ve silebilir. Kimlik bilgileri yalnızca insana aittir ve ajana hiçbir zaman gösterilmez.",
  "Add profile": "Profil ekle",
  "No authenticated HTTP profiles are configured yet.": "Henüz kimlik doğrulamalı HTTP profili yapılandırılmadı.",
  "Needs credential": "Kimlik bilgisi gerekli",
  "Test": "Test et",
  "Delete": "Sil",
  "Profile ID": "Profil kimliği",
  "Display name": "Görünen ad",
  "HTTPS origin": "HTTPS origin",
  "Base path": "Temel yol",
  "Authentication": "Kimlik doğrulama",
  "Bearer token": "Bearer tokenı",
  "Secret header": "Gizli header",
  "Secret header name": "Gizli header adı",
  "Allowed methods": "İzin verilen yöntemler",
  "Allowed path prefixes": "İzin verilen yol önekleri",
  "Allowed agent headers": "İzin verilen ajan header’ları",
  "Request timeout (ms)": "İstek zaman aşımı (ms)",
  "Credential": "Kimlik bilgisi",
  "Leave blank to keep the saved credential. Saved credentials are write-only and are never loaded back into this page.": "Kayıtlı kimlik bilgisini korumak için boş bırakın. Kaydedilmiş kimlik bilgileri yalnızca yazılabilir ve bu sayfaya hiçbir zaman geri yüklenmez.",
  "Save profile": "Profili kaydet",
  "Cancel": "İptal",
  "Agent management on": "Ajan yönetimi açık",
  "Agent management off": "Ajan yönetimi kapalı",
  "Profile saved.": "Profil kaydedildi.",
  "Profile deleted.": "Profil silindi.",
  "HTTP profile management updated.": "HTTP profil yönetimi güncellendi.",
  "Delete this HTTP profile and its saved credential?": "Bu HTTP profilini ve kayıtlı kimlik bilgisini silmek istiyor musunuz?",
  "Equinox Local is connected to ChatGPT.": "Equinox Local ChatGPT'ye bağlı.",
  "Tunnel settings saved. Equinox Local is restarting safely…": "Tunnel ayarları kaydedildi. Equinox Local güvenli biçimde yeniden başlatılıyor…",
  "Equinox Local is restarting safely…": "Equinox Local güvenli biçimde yeniden başlatılıyor…",
  "Configuration saved safely.": "Yapılandırma güvenle kaydedildi.",
  "Saved · restart required": "Kaydedildi · yeniden başlatma gerekli",
  "Appearance": "Görünüm",
  "System": "Sistem",
  "Light": "Aydınlık",
  "Dark": "Karanlık",
  "Services": "Servisler",
  "Safety": "Güvenlik",
  "Private on this Mac · 127.0.0.1": "Bu Mac’e özel · 127.0.0.1",
  "Checking your Mac": "Mac’iniz kontrol ediliyor",
  "Equinox Local is collecting a private status summary.": "Equinox Local özel bir durum özeti topluyor.",
  "Everything is running normally": "Her şey normal çalışıyor",
  "Core services are ready. You only need to open a detail page when you want to change something.": "Temel servisler hazır. Yalnızca bir şeyi değiştirmek istediğinizde ayrıntı sayfasını açmanız yeterli.",
  "Some parts need your attention": "Bazı bölümler dikkatinizi gerektiriyor",
  "Review the highlighted status below before starting important agent work.": "Önemli ajan işlerine başlamadan önce aşağıdaki işaretli durumu gözden geçirin.",
  "Status is still loading": "Durum hâlâ yükleniyor",
  "The local API is reachable, but the runtime summary is not complete yet.": "Yerel API erişilebilir, ancak runtime özeti henüz tamamlanmadı.",
  "HEALTHY": "SAĞLIKLI",
  "DEGRADED": "BOZULMUŞ",
  "RECOVERING": "TOPARLANIYOR",
  "ATTENTION REQUIRED": "DİKKAT GEREKLİ",
  "ATTENTION": "DİKKAT",
});

function normalizeTheme(value) {
  return SUPPORTED_THEMES.has(value) ? value : "system";
}

function initialTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (SUPPORTED_THEMES.has(stored)) return stored;
  } catch {
    // A blocked localStorage must not prevent Control Center from loading.
  }
  return "system";
}

function resolvedTheme(theme = state?.theme || "system") {
  return theme === "system" ? (systemThemeMedia.matches ? "dark" : "light") : theme;
}

function applyTheme() {
  const preference = normalizeTheme(state.theme);
  const resolved = resolvedTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = resolved === "dark" ? "#19191d" : "#f6f5f2";
  for (const button of document.querySelectorAll("[data-theme-value]")) {
    const active = button.dataset.themeValue === preference;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function setTheme(nextTheme, { persist = true } = {}) {
  state.theme = normalizeTheme(nextTheme);
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // Theme selection still applies for the current page if storage is unavailable.
    }
  }
  applyTheme();
}

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
  if (SUPPORTED_LANGUAGES.has(window.__equinoxNativeLanguage)) return window.__equinoxNativeLanguage;
  return String(navigator.language || "").toLowerCase().startsWith("tr") ? "tr" : "en";
}

function notifyNativeLanguage() {
  try {
    window.webkit?.messageHandlers?.equinoxNativeLanguage?.postMessage(state.language);
  } catch {
    // External browsers do not expose the native bridge; language still works normally.
  }
}

function localeForLanguage(language) {
  return language === "tr" ? "tr-TR" : "en-US";
}

const state = {
  language: initialLanguage(),
  theme: initialTheme(),
  activeSection: "dashboard",
  setupMode: false,
  lastRefreshedAt: null,
  refreshAllBusy: false,
  config: null,
  revision: null,
  status: null,
  health: null,
  doctor: null,
  doctorRepairs: null,
  doctorRepairBusy: false,
  doctorRepairResult: null,
  activity: [],
  tasks: [],
  selectedTaskId: null,
  taskDraft: null,
  taskDraftDirty: false,
  taskBusy: false,
  update: null,
  updateBusy: false,
  updateApplyBusy: false,
  onboarding: null,
  onboardingBusy: false,
  onboardingReconnectTimer: null,
  uninstallBusy: false,
  uninstallScheduled: false,
  telegram: null,
  webFileTransfer: null,
  telegramBotToken: "",
  telegramPairingPollBusy: false,
  telegramSetupSkipped: false,
  httpProfiles: null,
  httpProfileDraft: null,
  httpProfileBusy: false,
  httpProfileTestResults: {},
  browserDraft: null,
  browserSettingsTarget: "user",
  browserSettingsDirty: false,
  browserSettingsBusy: false,
  agentBrowserBusy: false,
  integrationBusy: false,
  pickerBusy: false,
  restartBusy: false,
  agentControlBusy: false,
  turnBudget: null,
  turnBudgetDraft: null,
  turnBudgetDirty: false,
  turnBudgetBusy: false,
  runtimeRestartTimer: null,
  dirty: false,
  restartRequired: false,
  dialogMode: null,
  dialogKind: "project",
  editingId: null,
  toastTimer: null,
  autoRefreshLiveBusy: false,
  autoRefreshMediumBusy: false,
  autoRefreshSlowBusy: false,
  lastAutoRefreshAt: 0,
};

const AUTO_REFRESH_LIVE_MS = 3_000;
const AUTO_REFRESH_MEDIUM_MS = 15_000;
const AUTO_REFRESH_SLOW_MS = 60_000;
const AUTO_REFRESH_FOCUS_DEBOUNCE_MS = 750;

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
  match = source.match(/^(\d+) tasks$/u);
  if (match) return `${match[1]} görev`;
  match = source.match(/^Checkpoint (\d+) · Updated (.+)$/u);
  if (match) return `Checkpoint ${match[1]} · Güncellendi ${match[2]}`;
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
  match = source.match(/^Bot is paired(?: to private user (.+))?\. Task replies, files\/photos and inline controls are (active|starting); agents can still send only to this account\.$/u);
  if (match) {
    const user = match[1] ? ` ${match[1]} özel kullanıcısına` : "";
    const stateText = match[2] === "active" ? "aktif" : "başlatılıyor";
    return `Bot${user} eşleştirildi. Görev yanıtları, dosya/fotoğraf alışverişi ve satır içi kontroller ${stateText}; ajanlar yine yalnızca bu hesaba mesaj gönderebilir.`;
  }
  match = source.match(/^Bot is paired(?: to private user (.+))?\. Agents can send only to this account; the private inbound queue uses the same one-human boundary\.$/u);
  if (match) {
    const user = match[1] ? ` ${match[1]} özel kullanıcısına` : "";
    return `Bot${user} eşleştirildi. Ajanlar yalnızca bu hesaba mesaj gönderebilir; özel gelen kutusu aynı tek-insan sınırını kullanır.`;
  }
  match = source.match(/^Private account (.+) is waiting for your confirmation\.$/u);
  if (match) return `${match[1]} özel hesabı doğrulamanızı bekliyor.`;
  match = source.match(/^Pairing is active(?: for @(.+))?\. Open the bot and send \/start\.$/u);
  if (match) return `Eşleştirme${match[1] ? ` @${match[1]} için` : ""} aktif. Botu açın ve /start gönderin.`;
  match = source.match(/^Detected (.+)\. Confirm that this is you\.$/u);
  if (match) return `${match[1]} algılandı. Bunun siz olduğunuzu doğrulayın.`;
  match = source.match(/^Telegram is paired(?: to private user (.+))?\. You can manage it later in Services\.$/u);
  if (match) return `Telegram${match[1] ? ` ${match[1]} özel kullanıcısına` : ""} eşleştirildi. Daha sonra Servisler bölümünden yönetebilirsiniz.`;
  match = source.match(/^Bot API is connected(?: to user (.+))?\. Agents can send messages only to this Telegram account; the recipient cannot be changed by an agent\.$/u);
  if (match) {
    const user = match[1] ? ` ${match[1]} kullanıcısına` : "";
    return `Bot API${user} bağlı. Ajanlar yalnızca bu Telegram hesabına mesaj gönderebilir; alıcı bir ajan tarafından değiştirilemez.`;
  }
  return source;
}

const DYNAMIC_TEXT_IDS = new Set([
  "sidebar-health-label", "sidebar-version", "section-kicker", "section-title", "last-refreshed",
  "agent-control-button", "restart-runtime-button", "onboarding-copy", "onboarding-badge", "setup-runtime-status",
  "setup-workspace-status", "setup-browser-status", "setup-tunnel-status", "setup-telegram-status", "setup-telegram-detail", "onboarding-connect-button",
  "runtime-health-badge", "overview-title", "overview-copy", "runtime-version", "runtime-uptime", "browser-status", "browser-version",
  "peekaboo-status", "peekaboo-detail", "api-status", "api-detail", "project-count", "folder-count",
  "default-project", "health-summary-title", "health-summary-badge", "health-summary-copy", "health-event-count",
  "health-evaluated-at", "doctor-title", "doctor-badge", "doctor-copy", "doctor-list", "doctor-summary",
  "doctor-checked-at", "doctor-fix-title", "doctor-fix-summary", "doctor-fix-copy", "doctor-repair-list", "doctor-repair-result", "update-title", "update-badge", "update-copy", "update-version", "update-checked-at",
  "check-update-button", "install-update-button", "root-count-label", "dirty-state", "project-list",
  "default-project-select", "workspace-project-select", "downloads-root-select", "control-center-address",
  "save-config-button", "agent-browser-page-status", "agent-browser-page-badge", "agent-browser-page-version", "agent-browser-connected-at",
  "agent-browser-control-state", "open-agent-browser-button", "agent-browser-note", "browser-page-status", "browser-page-badge", "browser-page-version", "browser-connected-at",
  "browser-control-state", "apply-browser-settings", "browser-settings-note", "permissions-list", "agent-access-badge",
  "agent-control-badge", "agent-control-copy", "active-terminal-count", "active-process-count", "active-work-count",
  "turn-budget-badge", "turn-budget-copy", "turn-budget-elapsed", "turn-budget-remaining", "turn-budget-stage", "turn-budget-fallback-reset", "save-turn-budget-button",
  "local-execution-badge", "save-agent-access-button", "uninstall-badge",
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
  notifyNativeLanguage();
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
  setup: ["Getting started", "Setup Equinox Local"],
  dashboard: ["Your workspace", "Overview"],
  projects: ["Your workspace", "Projects & folders"],
  tasks: ["Your workspace", "Tasks"],
  browser: ["Browser contexts", "Browser"],
  permissions: ["Agent control", "Safety & access"],
  integrations: ["Optional capabilities", "Services"],
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
  const { backgroundRefresh = false, headers: optionHeaders = {}, ...fetchOptions } = options;
  const headers = { ...optionHeaders };
  if (backgroundRefresh) headers["x-equinox-background-refresh"] = "1";
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...fetchOptions,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
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
  if (state.setupMode && section !== "setup") return;
  if (!state.setupMode && section === "setup") return;
  const changed = state.activeSection !== section;
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
  if (changed) {
    $("main-content").scrollIntoView({ block: "start", behavior: "instant" });
  }
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
  if (runtimeHealth === "HEALTHY") {
    setText("overview-title", "Your Mac is ready");
    setText("overview-copy", "Local tools are ready. Your agent stays in ChatGPT on the web; its connected tools run here on your Mac.");
  } else if (runtimeHealth === "UNKNOWN") {
    setText("overview-title", "Status is still loading");
    setText("overview-copy", "The local API is reachable, but the runtime summary is not complete yet.");
  } else {
    setText("overview-title", "Some parts need your attention");
    setText("overview-copy", "Review the highlighted status below before starting important agent work.");
  }
  const paused = status.agentControl?.paused === true || status.agentControl?.state === "PAUSED";
  if (paused) {
    setText("overview-title", "Your agent is paused");
    setText("overview-copy", "Local stays connected for read-only status. Resume when you are ready; stopped work will not restart on its own.");
  }

  const onboarding = state.onboarding;
  const connection = status.chatgptConnection || null;
  const connectionAvailable = connection?.available === true || (!connection && onboarding?.available === true);
  const connectionNeedsAttention = connection
    ? connection.needsAttention === true
    : onboarding?.needsAttention === true;
  const connectionConnected = connection
    ? connection.connected === true
    : onboarding?.connectedThroughTunnel === true;
  const connectionLabel = !connectionAvailable
    ? "Connection status unavailable"
    : connectionNeedsAttention
      ? "Connection needs attention"
      : connectionConnected
        ? (connection?.mode === "source" ? "MCP runtime connected" : "ChatGPT connected")
        : "ChatGPT not connected";
  setBadge("chatgpt-connection-badge", connectionLabel,
    !connectionAvailable ? "neutral" : connectionNeedsAttention ? "warn" : connectionConnected ? "good" : "neutral");

  setBadge("health-summary-badge", runtimeHealth === "UNKNOWN" ? "Unknown" : runtimeHealth, runtimeTone);
  setText("runtime-version", status.server?.version ? `v${status.server.version}` : "—");
  setText("runtime-uptime", formatUptime(status.server?.uptimeSeconds));
  setText("sidebar-version", status.server?.version ? `Equinox Local ${status.server.version}` : "Local runtime");
  setText("sidebar-health-label", runtimeHealth === "HEALTHY" ? "Runtime healthy" : runtimeHealth.toLowerCase().replaceAll("_", " "));
  setDot("sidebar-health-dot", dotToneForHealth(runtimeHealth));

  const defaultBrowser = browser.contexts?.agent || {};
  const browserConsentRequired = defaultBrowser.ready && defaultBrowser.consentAccepted === false;
  const browserLabel = browserConsentRequired
    ? "Connected · consent required"
    : defaultBrowser.ready && defaultBrowser.controlEnabled === false
      ? "Connected · automation off"
      : defaultBrowser.ready
        ? "Ready"
        : browser.agentBrowser?.pairing
          ? "Waiting for extension"
          : browser.agentBrowser?.setupComplete
            ? "Closed"
            : "Setup needed";
  setText("browser-status", browserLabel);
  setText("browser-version", defaultBrowser.extensionVersion ? `Extension ${defaultBrowser.extensionVersion}` : "Agent Browser · isolated default");
  setDot("browser-status-dot", defaultBrowser.ready ? (browserConsentRequired || defaultBrowser.controlEnabled === false ? "warn" : "good") : browser.agentBrowser?.setupComplete ? "neutral" : "warn");

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

function moveUninstallCard(setupMode) {
  const card = $("uninstall-card");
  const target = setupMode ? $("setup-uninstall-slot") : $("permissions-uninstall-slot");
  if (card && target && card.parentElement !== target) target.appendChild(card);
}

function applySetupMode(setupMode) {
  const previous = state.setupMode;
  state.setupMode = setupMode;
  document.body.classList.toggle("setup-mode", setupMode);
  $("control-center-nav").hidden = setupMode;
  $("setup-nav").hidden = !setupMode;
  moveUninstallCard(setupMode);
  if (setupMode && state.activeSection !== "setup") switchSection("setup");
  if (!setupMode && state.activeSection === "setup") switchSection("dashboard");
  if (previous && !setupMode) showToast("Setup complete. ChatGPT can now reach this Mac.");
}

function renderOnboarding() {
  const onboarding = state.onboarding || {};
  const setupMode = onboarding.available === true && onboarding.setupComplete !== true;
  applySetupMode(setupMode);
  if (!setupMode) return;

  const runtimeReady = Boolean(state.health?.controlCenter?.active && state.status?.server?.version);
  setBadge("setup-runtime-status", runtimeReady ? "Ready" : "Checking", runtimeReady ? "good" : "neutral");

  if (onboarding.needsAttention) {
    setBadge("setup-tunnel-status", "Needs attention", "warn");
    setText("onboarding-copy", onboarding.issue || "The saved tunnel connection needs attention. Re-enter the Runtime API key to repair it.");
  } else if (onboarding.connectedThroughTunnel) {
    setBadge("setup-tunnel-status", "Connected", "good");
    setText("onboarding-copy", "Finish the remaining steps. Setup unlocks only after a real ChatGPT tool request reaches this Mac.");
  } else if (onboarding.transportConfigured) {
    setBadge("setup-tunnel-status", "Connecting", "warn");
    setText("onboarding-copy", "Tunnel settings are saved. Equinox Local is reconnecting through your private tunnel.");
  } else {
    setBadge("setup-tunnel-status", "Not connected", "warn");
    setText("onboarding-copy", "Create the tunnel, add Equinox Local to ChatGPT, install Equinox Browser, then verify the first real tool call.");
  }

  const tunnelIdInput = $("onboarding-tunnel-id");
  if (tunnelIdInput && document.activeElement !== tunnelIdInput && onboarding.tunnelId && !tunnelIdInput.value) {
    tunnelIdInput.value = onboarding.tunnelId;
  }
  const runtimeKeyInput = $("onboarding-runtime-key");
  const connectButton = $("onboarding-connect-button");
  const tunnelForm = $("onboarding-tunnel-form");
  if (tunnelForm) tunnelForm.hidden = onboarding.connectedThroughTunnel === true && onboarding.needsAttention !== true;
  if (connectButton) {
    connectButton.disabled = state.onboardingBusy;
    connectButton.textContent = localizeUiText(state.onboardingBusy ? "Connecting…" : "Save & connect");
  }
  if (tunnelIdInput) tunnelIdInput.disabled = state.onboardingBusy;
  if (runtimeKeyInput) runtimeKeyInput.disabled = state.onboardingBusy;
  $("onboarding-reconnect").hidden = !state.onboardingBusy;

  const tunnelCopy = $("setup-tunnel-copy-value");
  if (tunnelCopy) tunnelCopy.textContent = onboarding.tunnelId || localizeUiText("Tunnel ID appears after step 2");
  const tunnelCopyButton = $("copy-setup-tunnel-id");
  if (tunnelCopyButton) tunnelCopyButton.disabled = !onboarding.tunnelId;

  if (onboarding.agentCommandReceived) {
    setBadge("setup-chatgpt-status", "Verified", "good");
  } else if (onboarding.connectedThroughTunnel) {
    setBadge("setup-chatgpt-status", "Configure in ChatGPT", "warn");
  } else {
    setBadge("setup-chatgpt-status", "Waiting for tunnel", "neutral");
  }

  if (!onboarding.browserConnected) {
    setBadge("setup-browser-status", "Not connected", "warn");
    setText("setup-browser-detail", "Install Equinox Browser in Your Browser and open the extension.");
  } else if (!onboarding.browserConsentAccepted) {
    setBadge("setup-browser-status", "Accept disclosure", "warn");
    setText("setup-browser-detail", "Equinox Browser is connected. Review and accept the browser-data disclosure in the extension.");
  } else if (!onboarding.browserControlEnabled) {
    setBadge("setup-browser-status", "Enable Browser Control", "warn");
    setText("setup-browser-detail", "Disclosure accepted. Turn Browser Control on to finish the required browser connection.");
  } else {
    setBadge("setup-browser-status", "Ready", "good");
    setText("setup-browser-detail", "Equinox Browser is connected, consented and Browser Control is on.");
  }

  const telegram = state.telegram || {};
  const telegramPairing = telegram.pairing || {};
  const telegramReady = telegram.configured === true && telegram.ready === true;
  const telegramForm = $("setup-telegram-form");
  const telegramPairingBox = $("setup-telegram-pairing");
  const telegramToken = $("setup-telegram-token");
  const telegramBotLink = $("setup-telegram-bot-link");
  const telegramConfirm = $("setup-telegram-confirm");
  if (telegramToken && document.activeElement !== telegramToken && !telegramToken.value) telegramToken.value = state.telegramBotToken;
  if (telegramReady) {
    setBadge("setup-telegram-status", "Ready", "good");
    if (telegramForm) telegramForm.hidden = true;
    if (telegramPairingBox) telegramPairingBox.hidden = false;
    setText("setup-telegram-detail", `Telegram is paired${telegram.userIdHint ? ` to private user ${telegram.userIdHint}` : ""}. You can manage it later in Services.`);
    if (telegramConfirm) telegramConfirm.hidden = true;
    $("setup-telegram-cancel").hidden = true;
  } else if (state.telegramSetupSkipped && !telegramPairing.active) {
    setBadge("setup-telegram-status", "Skipped", "neutral");
    if (telegramForm) telegramForm.hidden = true;
    if (telegramPairingBox) telegramPairingBox.hidden = false;
    setText("setup-telegram-detail", "Skipped for now. Telegram remains available later in Control Center → Services.");
    if (telegramConfirm) telegramConfirm.hidden = true;
    $("setup-telegram-cancel").hidden = true;
  } else if (telegramPairing.active) {
    setBadge("setup-telegram-status", telegramPairing.candidateFound ? "Confirm account" : "Pairing", "warn");
    if (telegramForm) telegramForm.hidden = true;
    if (telegramPairingBox) telegramPairingBox.hidden = false;
    setText("setup-telegram-detail", telegramPairing.candidateFound
      ? `Detected ${telegramPairing.candidateLabel || telegramPairing.userIdHint || "a private Telegram account"}. Confirm that this is you.`
      : `Pairing is active${telegramPairing.botUsername ? ` for @${telegramPairing.botUsername}` : ""}. Open the bot and send /start.`);
    if (telegramConfirm) telegramConfirm.hidden = !telegramPairing.candidateFound;
    $("setup-telegram-cancel").hidden = false;
  } else {
    setBadge("setup-telegram-status", "Recommended", "neutral");
    if (telegramForm) telegramForm.hidden = false;
    if (telegramPairingBox) telegramPairingBox.hidden = true;
  }
  if (telegramBotLink) {
    telegramBotLink.hidden = !telegramPairing.botUsername;
    if (telegramPairing.botUsername) telegramBotLink.href = `https://t.me/${telegramPairing.botUsername}`;
  }
  $("setup-telegram-start").disabled = state.integrationBusy || !state.telegramBotToken.trim();

  if (onboarding.agentCommandReceived) {
    setBadge("setup-verify-status", "Command received", "good");
    setText("setup-verify-detail", state.language === "tr"
      ? `İlk Equinox Local araç çağrısı ${formatDate(onboarding.firstAgentCommandAt)} tarihinde alındı.`
      : `First Equinox Local tool call received ${formatDate(onboarding.firstAgentCommandAt)}.`);
  } else {
    setBadge("setup-verify-status", "Waiting", "warn");
    setText("setup-verify-detail", "Waiting for the first Equinox Local tool call from ChatGPT. This is the final setup check.");
  }

  const browserReady = onboarding.browserConnected && onboarding.browserConsentAccepted && onboarding.browserControlEnabled;
  const almostReady = onboarding.connectedThroughTunnel && browserReady;
  setBadge("onboarding-badge", almostReady ? "Ready to verify" : "Setup in progress", almostReady ? "good" : "warn");
}

async function copySetupText(text, successMessage) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch (error) {
    showError(new Error(`Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function runDoctorRepair(incident, fix) {
  if (state.doctorRepairBusy || !incident?.incidentId || !fix?.id) return;
  const question = state.language === "tr"
    ? `“${localizeUiText(fix.label)}” düzeltmesi uygulansın mı?\n\n${fix.description}\n\nEquinox işlemden hemen önce teşhisi yeniden doğrulayacak ve sonrasında sonucu tekrar kontrol edecek.`
    : `Apply “${fix.label}”?\n\n${fix.description}\n\nEquinox will re-check the diagnosis immediately before the fixed recipe runs and verify the result afterwards.`;
  if (!window.confirm(question)) return;

  state.doctorRepairBusy = true;
  state.doctorRepairResult = null;
  renderDoctor();
  clearError();
  try {
    const response = await mutationJson("/api/v1/doctor/repair", "POST", {
      incidentId: incident.incidentId,
      recipeId: fix.id,
    });
    state.doctorRepairResult = response.result || null;
    const [doctor, repairs] = await Promise.all([
      requestJson("/api/v1/doctor").catch(() => ({ doctor: state.doctor })),
      requestJson("/api/v1/doctor/repairs").catch(() => ({ repairs: state.doctorRepairs })),
    ]);
    state.doctor = doctor.doctor || state.doctor;
    state.doctorRepairs = repairs.repairs || state.doctorRepairs;
    showToast(response.result?.verification?.resolved ? "Doctor fix verified." : "Doctor fix completed but the incident still needs attention.");
  } catch (error) {
    showError(error);
  } finally {
    state.doctorRepairBusy = false;
    renderDoctor();
  }
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
      ? "Equinox Local checked the runtime, private configuration, update path, Equinox Browser and optional integrations without exposing local paths or secrets."
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

  const plan = state.doctorRepairs || {};
  const incidents = Array.isArray(plan.incidents) ? plan.incidents : [];
  const actionable = incidents.filter((incident) => Array.isArray(incident.fixes) && incident.fixes.length > 0 && ["ACTIVE", "ATTENTION REQUIRED"].includes(incident.state));
  setBadge("doctor-fix-summary", actionable.length > 0 ? "Safe fixes available" : "No fixes needed", actionable.length > 0 ? "warn" : "good");
  setText("doctor-fix-copy", actionable.length > 0
    ? `${actionable.length} diagnosed incident${actionable.length === 1 ? " has" : "s have"} a predefined bounded fix. Review exactly what will change before applying it.`
    : "No active repairable incidents were diagnosed.");

  const repairList = $("doctor-repair-list");
  if (repairList) {
    repairList.replaceChildren();
    for (const incident of actionable) {
      const card = document.createElement("article");
      card.className = "doctor-repair-card";

      const head = document.createElement("div");
      head.className = "doctor-repair-head";
      const headCopy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = incident.title || incident.code || "Diagnosed issue";
      const meta = document.createElement("small");
      meta.textContent = `${incident.state || "ACTIVE"} · ${incident.component || "runtime"}${incident.projectId ? ` · ${incident.projectId}` : ""}`;
      headCopy.append(title, meta);
      const severity = document.createElement("span");
      setBadge(severity, incident.severity || "warn", ["error", "critical"].includes(incident.severity) ? "warn" : "neutral");
      head.append(headCopy, severity);

      const summary = document.createElement("p");
      summary.textContent = incident.summary || incident.recommendation || "Equinox diagnosed a repairable runtime issue.";
      card.append(head, summary);

      for (const fix of incident.fixes) {
        const action = document.createElement("div");
        action.className = "doctor-repair-action";
        const actionCopy = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = localizeUiText(fix.label || "Fix safely");
        const description = document.createElement("small");
        description.textContent = fix.description || "Predefined bounded repair recipe.";
        actionCopy.append(label, description);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button secondary compact";
        button.textContent = localizeUiText(state.doctorRepairBusy ? "Repair running…" : "Fix safely");
        button.disabled = state.doctorRepairBusy;
        button.addEventListener("click", () => { void runDoctorRepair(incident, fix); });
        action.append(actionCopy, button);
        card.append(action);
      }
      repairList.append(card);
    }
  }

  const resultBox = $("doctor-repair-result");
  if (resultBox) {
    const result = state.doctorRepairResult;
    resultBox.hidden = !result;
    resultBox.className = "doctor-repair-result";
    if (result) {
      const resolved = result.verification?.resolved === true;
      resultBox.classList.add(resolved ? "is-good" : "is-warn");
      const outcome = result.repair?.outcome || "UNKNOWN";
      const summary = result.repair?.summary || "Repair finished.";
      const verification = resolved ? "Verified: the diagnosed incident is resolved." : `Verification: ${result.verification?.incident?.state || "incident still requires attention"}.`;
      resultBox.textContent = `${outcome} · ${summary} ${verification}`;
    }
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
  const localExecution = access.terminal !== false;
  setBadge(
    "agent-access-badge",
    localExecution ? "Terminal-first" : "Restricted mode",
    localExecution ? "good" : "warn",
  );
  setBadge(
    "local-execution-badge",
    localExecution ? "Core · enabled" : "Disabled",
    localExecution ? "good" : "warn",
  );
  $("save-agent-access-button").disabled = !state.dirty || state.restartRequired;

  for (const [id, definition] of Object.entries(state.config.projects || {})) {
    const card = document.createElement("article");
    card.className = "permission-card";
    const meta = document.createElement("div");
    meta.className = "permission-meta";
    const title = document.createElement("h4");
    title.textContent = definition.name;
    const badge = makeMiniBadge(access.files === "full" ? "Structured shortcut" : "Structured scope");
    meta.append(title, badge);
    const copy = document.createElement("p");
    copy.textContent = localizeUiText(
      access.files === "full"
        ? "This project is a named shortcut for structured capabilities; those capabilities can also use other accessible paths."
        : "Root-aware structured capabilities stay contained to this configured root. Terminal is not constrained by this scope.",
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
  const telegram = state.telegram || {};
  const configured = Boolean(telegram.configured && telegram.ready);
  const needsAttention = Boolean(telegram.needsAttention);
  const pairing = telegram.pairing || {};
  const card = createIntegrationCard(
    "Telegram",
    configured
      ? `Bot is paired${telegram.userIdHint ? ` to private user ${telegram.userIdHint}` : ""}. Telegram remote control is ${telegram.remoteControl?.enabled === false ? "off" : "on"}; task replies, files/photos and inline controls are ${telegram.taskInbox?.running ? "active" : "starting"}. Agents can still send only to this account.`
      : needsAttention
        ? "Saved Telegram state needs attention. Disconnect and pair the bot again safely."
        : pairing.active
          ? pairing.candidateFound
            ? `Private account ${pairing.candidateLabel || pairing.userIdHint || "detected"} is waiting for your confirmation.`
            : `Pairing is active${pairing.botUsername ? ` for @${pairing.botUsername}` : ""}. Open the bot and send /start.`
          : "Pair a Telegram bot to one private account. No Telegram user ID is required.",
    configured ? "Ready" : needsAttention ? "Needs attention" : pairing.active ? "Pairing" : "Not connected",
    configured ? "good" : needsAttention ? "warn" : pairing.active ? "warn" : "neutral",
    configured
      ? [
          { label: "Send test", onClick: testTelegramConnection },
          { label: "Disconnect", onClick: disconnectTelegramConnection },
        ]
      : pairing.active
        ? pairing.candidateFound
          ? [
              { label: "Pair this account", primary: true, onClick: confirmTelegramPairingUi },
              { label: "Cancel pairing", onClick: cancelTelegramPairingUi },
            ]
          : [
              ...(pairing.botUsername ? [{ label: "Open your bot ↗", href: `https://t.me/${pairing.botUsername}` }] : []),
              { label: "Cancel pairing", onClick: cancelTelegramPairingUi },
            ]
        : [],
  );

  if (configured) {
    const remoteControl = telegram.remoteControl || { enabled: true };
    const toggle = document.createElement("label");
    toggle.className = "toggle-field";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = localizeUiText("Telegram remote control");
    const help = document.createElement("small");
    help.textContent = localizeUiText("Allow the paired Telegram account to control Tasks, Chat Bridge and Local controls. Turning this off ignores and discards inbound Telegram commands/messages while outbound notifications remain available.");
    copy.append(title, help);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = remoteControl.enabled !== false;
    checkbox.disabled = state.integrationBusy;
    checkbox.addEventListener("change", () => void updateTelegramRemoteControlUi(checkbox.checked));
    toggle.append(copy, checkbox);
    card.append(toggle);
  }

  const downloads = telegram.downloads || null;
  if (downloads?.path) {
    const downloadBox = document.createElement("div");
    downloadBox.className = "integration-form";
    const title = document.createElement("strong");
    title.textContent = localizeUiText("Download folder");
    const location = document.createElement("code");
    location.textContent = downloads.path;
    location.style.overflowWrap = "anywhere";
    const help = document.createElement("small");
    help.textContent = localizeUiText("Incoming Telegram photos and documents are saved here. Changing this affects only new files; existing task attachments stay where they are. Files in this user-visible folder are not auto-deleted.");
    const actions = document.createElement("div");
    actions.className = "integration-actions";
    const changeButton = document.createElement("button");
    changeButton.type = "button";
    changeButton.className = "button secondary";
    changeButton.textContent = localizeUiText("Change folder…");
    changeButton.disabled = state.integrationBusy || state.pickerBusy;
    changeButton.addEventListener("click", () => void changeTelegramDownloadFolder());
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "button secondary";
    resetButton.textContent = localizeUiText("Reset to default");
    resetButton.disabled = state.integrationBusy || state.pickerBusy || downloads.isDefault === true;
    resetButton.addEventListener("click", () => void resetTelegramDownloadFolder());
    actions.append(changeButton, resetButton);
    downloadBox.append(title, location, help, actions);
    card.append(downloadBox);
  }

  if (!configured && !pairing.active) {
    const instructions = document.createElement("p");
    instructions.className = "integration-helper";
    instructions.textContent = localizeUiText("Create a bot with BotFather using /newbot, copy its HTTP API token, then start pairing here. You will confirm the detected private account before Equinox Local saves it.");
    card.append(instructions);

    const botFather = document.createElement("a");
    botFather.className = "button secondary";
    botFather.href = "https://t.me/BotFather";
    botFather.target = "_blank";
    botFather.rel = "noopener noreferrer";
    botFather.textContent = localizeUiText("Open BotFather ↗");
    card.append(botFather);

    const form = document.createElement("form");
    form.className = "integration-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void startTelegramPairingUi();
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
    tokenInput.addEventListener("input", () => {
      state.telegramBotToken = tokenInput.value;
      button.disabled = state.integrationBusy || !state.telegramBotToken.trim();
    });
    const tokenHelp = document.createElement("small");
    tokenHelp.textContent = localizeUiText("The token stays only on this Mac. Telegram user ID is discovered during pairing.");
    tokenLabel.append(tokenTitle, tokenInput, tokenHelp);
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "button primary";
    button.textContent = localizeUiText(state.integrationBusy ? "Starting pairing…" : "Pair Telegram");
    button.disabled = state.integrationBusy || !state.telegramBotToken.trim();
    form.append(tokenLabel, button);
    card.append(form);
  }
  return card;
}

function httpProfileDraftFrom(profile = null) {
  if (!profile) {
    return {
      existing: false,
      id: "",
      label: "",
      origin: "https://",
      basePath: "/api",
      authType: "bearer",
      authHeader: "x-api-key",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/"],
      allowedAgentHeaders: [],
      timeoutMs: 10_000,
    };
  }
  return {
    existing: true,
    id: profile.id,
    label: profile.label,
    origin: profile.origin,
    basePath: profile.basePath,
    authType: profile.authType,
    authHeader: profile.authType === "secret_header" ? profile.authHeader : "x-api-key",
    allowedMethods: [...(profile.allowedMethods || ["GET"])],
    allowedPathPrefixes: [...(profile.allowedPathPrefixes || ["/"])],
    allowedAgentHeaders: [...(profile.allowedAgentHeaders || [])],
    timeoutMs: profile.timeoutMs || 10_000,
  };
}

function setHttpProfileDraft(profile = null) {
  state.httpProfileDraft = profile === false ? null : httpProfileDraftFrom(profile);
  renderIntegrations();
}

function createHttpProfileField(labelText, control, helpText = "") {
  const label = document.createElement("label");
  label.className = "field";
  const title = document.createElement("span");
  title.textContent = localizeUiText(labelText);
  label.append(title, control);
  if (helpText) {
    const help = document.createElement("small");
    help.textContent = localizeUiText(helpText);
    label.append(help);
  }
  return label;
}

function createAuthenticatedHttpProfileForm() {
  const draft = state.httpProfileDraft;
  if (!draft) return null;
  const form = document.createElement("form");
  form.className = "integration-form http-profile-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveHttpProfile(form);
  });

  const grid = document.createElement("div");
  grid.className = "http-profile-form-grid";

  const idInput = document.createElement("input");
  idInput.name = "id";
  idInput.type = "text";
  idInput.autocomplete = "off";
  idInput.spellcheck = false;
  idInput.value = draft.id;
  idInput.placeholder = "moltbook";
  idInput.readOnly = draft.existing;
  idInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Profile ID", idInput));

  const labelInput = document.createElement("input");
  labelInput.name = "label";
  labelInput.type = "text";
  labelInput.autocomplete = "off";
  labelInput.value = draft.label;
  labelInput.placeholder = "Moltbook";
  labelInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Display name", labelInput));

  const originInput = document.createElement("input");
  originInput.name = "origin";
  originInput.type = "url";
  originInput.autocomplete = "off";
  originInput.spellcheck = false;
  originInput.value = draft.origin;
  originInput.placeholder = "https://api.example.com";
  originInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("HTTPS origin", originInput));

  const basePathInput = document.createElement("input");
  basePathInput.name = "basePath";
  basePathInput.type = "text";
  basePathInput.autocomplete = "off";
  basePathInput.spellcheck = false;
  basePathInput.value = draft.basePath;
  basePathInput.placeholder = "/api/v1";
  basePathInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Base path", basePathInput));

  const authSelect = document.createElement("select");
  authSelect.name = "authType";
  for (const [value, label] of [["bearer", "Bearer token"], ["secret_header", "Secret header"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = localizeUiText(label);
    option.selected = draft.authType === value;
    authSelect.append(option);
  }
  authSelect.disabled = state.httpProfileBusy;

  const headerInput = document.createElement("input");
  headerInput.name = "authHeader";
  headerInput.type = "text";
  headerInput.autocomplete = "off";
  headerInput.spellcheck = false;
  headerInput.value = draft.authHeader || "x-api-key";
  headerInput.placeholder = "x-api-key";
  headerInput.disabled = state.httpProfileBusy || draft.authType !== "secret_header";
  authSelect.addEventListener("change", () => {
    headerInput.disabled = state.httpProfileBusy || authSelect.value !== "secret_header";
  });
  grid.append(createHttpProfileField("Authentication", authSelect));
  grid.append(createHttpProfileField("Secret header name", headerInput));

  const paths = document.createElement("textarea");
  paths.name = "allowedPathPrefixes";
  paths.rows = 3;
  paths.spellcheck = false;
  paths.value = draft.allowedPathPrefixes.join("\n");
  paths.placeholder = "/posts\n/profile";
  paths.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Allowed path prefixes", paths));

  const headers = document.createElement("textarea");
  headers.name = "allowedAgentHeaders";
  headers.rows = 3;
  headers.spellcheck = false;
  headers.value = draft.allowedAgentHeaders.join("\n");
  headers.placeholder = "x-client-version";
  headers.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Allowed agent headers", headers));

  const timeoutInput = document.createElement("input");
  timeoutInput.name = "timeoutMs";
  timeoutInput.type = "number";
  timeoutInput.min = "1000";
  timeoutInput.max = "30000";
  timeoutInput.step = "1000";
  timeoutInput.value = String(draft.timeoutMs);
  timeoutInput.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField("Request timeout (ms)", timeoutInput));

  const credential = document.createElement("input");
  credential.name = "credential";
  credential.type = "password";
  credential.autocomplete = "new-password";
  credential.spellcheck = false;
  credential.placeholder = draft.existing ? "••••••••" : "";
  credential.disabled = state.httpProfileBusy;
  grid.append(createHttpProfileField(
    "Credential",
    credential,
    "Leave blank to keep the saved credential. Saved credentials are write-only and are never loaded back into this page.",
  ));

  const methods = document.createElement("fieldset");
  methods.className = "http-methods";
  methods.disabled = state.httpProfileBusy;
  const legend = document.createElement("legend");
  legend.textContent = localizeUiText("Allowed methods");
  methods.append(legend);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "allowedMethod";
    checkbox.value = method;
    checkbox.checked = draft.allowedMethods.includes(method);
    const text = document.createElement("span");
    text.textContent = method;
    label.append(checkbox, text);
    methods.append(label);
  }

  const actions = document.createElement("div");
  actions.className = "integration-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button primary";
  save.textContent = localizeUiText("Save profile");
  save.disabled = state.httpProfileBusy;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button secondary";
  cancel.textContent = localizeUiText("Cancel");
  cancel.disabled = state.httpProfileBusy;
  cancel.addEventListener("click", () => setHttpProfileDraft(false));
  actions.append(save, cancel);

  form.append(grid, methods, actions);
  return form;
}


function createAuthenticatedHttpProfilesCard() {
  const data = state.httpProfiles || { agentProfileManagementEnabled: true, profiles: [] };
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const managementEnabled = data.agentProfileManagementEnabled !== false;
  const card = createIntegrationCard(
    "Authenticated HTTP profiles",
    "Keep API credentials on this Mac while allowing agents to make bounded requests only to the HTTPS origins, methods and paths you approve.",
    managementEnabled ? "Agent management on" : "Agent management off",
    managementEnabled ? "good" : "neutral",
    [{ label: "Add profile", onClick: () => setHttpProfileDraft(null), primary: profiles.length === 0, disabled: state.httpProfileBusy }],
  );
  card.classList.add("http-profile-card", "integration-card-wide");

  const toggle = document.createElement("label");
  toggle.className = "toggle-field http-profile-management";
  const toggleCopy = document.createElement("div");
  const toggleTitle = document.createElement("strong");
  toggleTitle.textContent = localizeUiText("Allow agents to manage HTTP profiles");
  const toggleHelp = document.createElement("small");
  toggleHelp.textContent = localizeUiText("Agents may create, edit and delete profile structure. Credentials remain human-only and are never exposed to the agent.");
  toggleCopy.append(toggleTitle, toggleHelp);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = managementEnabled;
  checkbox.disabled = state.httpProfileBusy;
  checkbox.addEventListener("change", () => {
    void updateHttpProfileManagement(checkbox.checked);
  });
  toggle.append(toggleCopy, checkbox);
  card.append(toggle);

  const profileList = document.createElement("div");
  profileList.className = "http-profile-list";
  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "http-profile-empty";
    empty.textContent = localizeUiText("No authenticated HTTP profiles are configured yet.");
    profileList.append(empty);
  } else {
    for (const profile of profiles) {
      const row = document.createElement("article");
      row.className = "http-profile-row";
      const heading = document.createElement("div");
      heading.className = "http-profile-heading";
      const title = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = profile.label;
      const id = document.createElement("code");
      id.textContent = profile.id;
      title.append(name, id);
      const badge = document.createElement("span");
      setBadge(badge, profile.ready ? "Ready" : "Needs credential", profile.ready ? "good" : "warn");
      heading.append(title, badge);

      const endpoint = document.createElement("code");
      endpoint.className = "http-profile-endpoint";
      endpoint.textContent = `${profile.origin}${profile.basePath === "/" ? "" : profile.basePath}`;

      const scope = document.createElement("p");
      const paths = (profile.allowedPathPrefixes || []).join(", ");
      scope.textContent = `${(profile.allowedMethods || []).join(" · ")} · ${paths || "/"}`;

      const actions = document.createElement("div");
      actions.className = "integration-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "button secondary";
      edit.textContent = localizeUiText("Edit");
      edit.disabled = state.httpProfileBusy;
      edit.addEventListener("click", () => setHttpProfileDraft(profile));

      const test = document.createElement("button");
      test.type = "button";
      test.className = "button secondary";
      test.textContent = localizeUiText("Test");
      test.disabled = state.httpProfileBusy || !profile.ready;
      test.addEventListener("click", () => void testHttpProfileConnection(profile));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button danger";
      remove.textContent = localizeUiText("Delete");
      remove.disabled = state.httpProfileBusy;
      remove.addEventListener("click", () => void deleteHttpProfileFromControlCenter(profile));

      actions.append(edit, test, remove);
      row.append(heading, endpoint, scope, actions);
      const lastTest = state.httpProfileTestResults[profile.id];
      if (lastTest) {
        const testResult = document.createElement("small");
        testResult.className = "http-profile-test-result";
        testResult.textContent = lastTest;
        row.append(testResult);
      }
      profileList.append(row);
    }
  }
  card.append(profileList);

  const form = createAuthenticatedHttpProfileForm();
  if (form) card.append(form);
  return card;
}


function createWebFileTransferCard() {
  const settings = state.webFileTransfer || {};
  const card = createIntegrationCard(
    "Web file transfer",
    "Files sent from ChatGPT to this Mac are saved here by default. Explicit destinations still override this folder.",
    settings.path ? "Ready" : "Not available",
    settings.path ? "good" : "neutral",
  );
  if (!settings.path) return card;
  const box = document.createElement("div");
  box.className = "integration-form";
  const title = document.createElement("strong"); title.textContent = localizeUiText("Download folder");
  const location = document.createElement("code"); location.textContent = settings.path; location.style.overflowWrap = "anywhere";
  const actions = document.createElement("div"); actions.className = "integration-actions";
  const change = document.createElement("button"); change.type = "button"; change.className = "button secondary"; change.textContent = localizeUiText("Change folder…"); change.disabled = state.integrationBusy || state.pickerBusy; change.addEventListener("click", () => void changeWebImportFolder());
  const reset = document.createElement("button"); reset.type = "button"; reset.className = "button secondary"; reset.textContent = localizeUiText("Reset to default"); reset.disabled = state.integrationBusy || state.pickerBusy || settings.isDefault === true; reset.addEventListener("click", () => void resetWebImportFolder());
  actions.append(change, reset); box.append(title, location, actions); card.append(box); return card;
}

function renderIntegrations() {
  const list = $("integration-list");
  list.replaceChildren();
  const browser = state.status?.browser || {};
  const peekaboo = state.status?.peekaboo || {};
  const agentBrowser = browser.contexts?.agent || {};
  const userBrowser = browser.contexts?.user || {};
  const browserStatus = agentBrowser.ready
    ? agentBrowser.consentAccepted === false
      ? "Consent required"
      : (agentBrowser.controlEnabled === false ? "Automation off" : "Ready")
    : browser.agentBrowser?.pairing
      ? "Waiting for extension"
      : browser.agentBrowser?.setupComplete
        ? "Closed"
        : "Setup needed";
  const browserTone = agentBrowser.ready
    ? (agentBrowser.consentAccepted === false || agentBrowser.controlEnabled === false ? "warn" : "good")
    : browser.agentBrowser?.setupComplete ? "neutral" : "warn";
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
      `Agent Browser ${agentBrowser.ready ? "ready" : browser.agentBrowser?.setupComplete ? "closed" : "not ready"} · Your Browser ${userBrowser.ready ? "connected" : "not connected"}. Both contexts use the same Chrome Web Store extension and Native Messaging bridge.`,
      browserStatus,
      browserTone,
      [
        { label: "Browser settings", onClick: () => switchSection("browser"), primary: !agentBrowser.ready },
        { label: "Chrome Web Store", href: EQUINOX_BROWSER_STORE_URL },
      ],
    ),
    createIntegrationCard(
      "Peekaboo desktop bridge",
      peekaboo.version
        ? `Optional macOS desktop capability · Peekaboo ${peekaboo.version}.`
        : "Optional macOS desktop capability. It is not required for Terminal, GitHub or Browser operations.",
      peekabooStatus,
      peekabooTone,
    ),
    createWebFileTransferCard(),
    createTelegramIntegrationCard(),
    createAuthenticatedHttpProfilesCard(),
  );
}

function browserContextStatus(target) {
  const browser = state.status?.browser || {};
  const contextual = browser.contexts?.[target];
  if (contextual && typeof contextual === "object") return contextual;
  if (target !== "user") return {};
  return {
    ready: Boolean(browser.ready),
    connectedAt: browser.connectedAt ?? null,
    extensionVersion: browser.extensionVersion ?? null,
    consentAccepted: browser.consentAccepted ?? null,
    controlEnabled: browser.controlEnabled ?? null,
    agentCursorEnabled: browser.agentCursorEnabled ?? null,
    agentCursorName: browser.agentCursorName ?? null,
  };
}

function browserSettingsFromStatus(target = state.browserSettingsTarget) {
  const browser = browserContextStatus(target);
  if (
    typeof browser.controlEnabled !== "boolean" ||
    typeof browser.agentCursorEnabled !== "boolean" ||
    typeof browser.agentCursorName !== "string"
  ) {
    return null;
  }
  return {
    context: target,
    enabled: browser.controlEnabled,
    agentCursorEnabled: browser.agentCursorEnabled,
    agentCursorName: browser.agentCursorName,
  };
}

function browserContextLabel(browser, { unavailableLabel = "Extension not connected" } = {}) {
  const consentRequired = browser.ready && browser.consentAccepted === false;
  const controlOff = browser.ready && !consentRequired && browser.controlEnabled === false;
  const label = consentRequired
    ? "Connected · consent required"
    : controlOff
      ? "Connected · automation off"
      : browser.ready
        ? "Ready"
        : unavailableLabel;
  const badge = browser.ready
    ? (consentRequired ? "Consent required" : controlOff ? "Automation off" : "Ready")
    : unavailableLabel;
  const tone = browser.ready ? (consentRequired || controlOff ? "warn" : "good") : "neutral";
  return { consentRequired, controlOff, label, badge, tone };
}

function renderBrowserPage() {
  const browser = state.status?.browser || {};
  const agent = browserContextStatus("agent");
  const user = browserContextStatus("user");
  const manager = browser.agentBrowser || {};
  const agentView = browserContextLabel(agent, {
    unavailableLabel: manager.pairing ? "Waiting for extension" : manager.setupComplete ? "Closed" : "Setup needed",
  });
  const userView = browserContextLabel(user, {
    unavailableLabel: browser.active ? "Extension not connected" : "Unavailable",
  });

  setText("agent-browser-page-status", agentView.label);
  setBadge("agent-browser-page-badge", agentView.badge, agentView.tone);
  setText("agent-browser-page-version", agent.extensionVersion || "—");
  setText("agent-browser-connected-at", formatDate(agent.connectedAt));
  setText(
    "agent-browser-control-state",
    agentView.consentRequired
      ? "Consent required"
      : typeof agent.controlEnabled === "boolean"
        ? (agent.controlEnabled ? "Allowed" : "Off")
        : "Unavailable",
  );
  const agentButton = $("open-agent-browser-button");
  agentButton.disabled = state.agentBrowserBusy || Boolean(agent.ready) || manager.supported === false;
  agentButton.textContent = localizeUiText(
    state.agentBrowserBusy ? "Opening…" : agent.ready ? "Agent Browser is open" : "Open Agent Browser",
  );
  setText(
    "agent-browser-note",
    agentView.consentRequired
      ? "Open the Equinox Browser popup in Agent Browser, review the data-use disclosure, and enable browser control there."
      : agent.ready && agent.controlEnabled === false
        ? "Equinox Browser is connected in Agent Browser, but browser automation is turned off in that profile."
        : agent.ready
          ? "Agent Browser is ready and is the default target for browser automation."
          : manager.pairing
            ? "Waiting for Equinox Browser to connect from the isolated Agent Browser profile."
            : manager.setupComplete
              ? "Agent Browser setup is complete and the isolated browser is currently closed. It will open automatically when an agent needs it."
              : "On first use, Agent Browser opens Chrome Web Store inside the isolated profile so Equinox Browser can be installed there.",
  );

  setText("browser-page-status", userView.label);
  setBadge("browser-page-badge", userView.badge, userView.tone);
  setText("browser-page-version", user.extensionVersion || "—");
  setText("browser-connected-at", formatDate(user.connectedAt));
  setText(
    "browser-control-state",
    userView.consentRequired
      ? "Consent required"
      : typeof user.controlEnabled === "boolean"
        ? (user.controlEnabled ? "Allowed" : "Off")
        : "Unavailable",
  );

  const selected = browserContextStatus(state.browserSettingsTarget);
  const selectedView = browserContextLabel(selected, { unavailableLabel: "Extension not connected" });
  const baseline = browserSettingsFromStatus(state.browserSettingsTarget);
  if (!state.browserSettingsDirty) state.browserDraft = baseline ? { ...baseline } : null;
  const available = Boolean(selected.ready && baseline && state.browserDraft);
  const disabled = !available || state.browserSettingsBusy;
  const targetSelect = $("browser-settings-target");
  const controlToggle = $("browser-control-toggle");
  const cursorToggle = $("browser-cursor-toggle");
  const nameInput = $("browser-agent-name");
  const applyButton = $("apply-browser-settings");

  targetSelect.value = state.browserSettingsTarget;
  targetSelect.disabled = state.browserSettingsBusy;
  controlToggle.disabled = disabled || selectedView.consentRequired;
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
    selectedView.consentRequired
      ? "Open the Equinox Browser popup in the selected profile, review the data-use disclosure, and enable browser control there."
      : available
        ? "Settings apply immediately through Native Messaging and do not require an Equinox Local restart."
        : state.browserSettingsTarget === "agent"
          ? (manager.setupComplete
            ? "Open Agent Browser to manage settings for the already configured isolated profile."
            : "Open Agent Browser and install Equinox Browser in that isolated profile to manage its settings.")
          : "Connect Equinox Browser in Your Browser to manage its settings from Control Center.",
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

function formatTurnBudgetDuration(ms) {
  if (!Number.isFinite(ms)) return "—";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function turnBudgetStageFor(elapsedMs, cutoffMinutes) {
  const cutoffMs = cutoffMinutes * 60_000;
  if (elapsedMs >= cutoffMs) return "overdue";
  if (elapsedMs >= Math.max(0, cutoffMs - 2 * 60_000)) return "finalize";
  if (elapsedMs >= Math.max(0, cutoffMs - 4 * 60_000)) return "checkpoint";
  return "running";
}

function renderTurnBudgetLive() {
  const budget = state.turnBudget || state.status?.turnBudget || null;
  if (!budget?.enabled) {
    setBadge("turn-budget-badge", "Off", "neutral");
    setText("turn-budget-elapsed", "—");
    setText("turn-budget-remaining", "—");
    setText("turn-budget-stage", "Disabled");
    setText("turn-budget-copy", "Turn Budget is disabled. Equinox Local will not add per-turn finalization guidance.");
    return;
  }
  const active = budget.active;
  if (!active) {
    setBadge("turn-budget-badge", `${budget.cutoffMinutes} min`, "good");
    setText("turn-budget-elapsed", "—");
    setText("turn-budget-remaining", "—");
    setText("turn-budget-stage", "Idle");
    setText("turn-budget-copy", "Waiting for the first Equinox Local call in an assistant turn.");
    return;
  }
  const startedAtMs = Date.parse(active.startedAt);
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : Number(active.elapsedMs) || 0;
  const remainingMs = Math.max(0, budget.cutoffMinutes * 60_000 - elapsedMs);
  const stage = turnBudgetStageFor(elapsedMs, budget.cutoffMinutes);
  const presentation = {
    running: ["Running", "good"],
    checkpoint: ["Checkpoint soon", "warn"],
    finalize: ["Finalizing", "warn"],
    overdue: ["Cutoff reached", "bad"],
  }[stage];
  setBadge("turn-budget-badge", presentation[0], presentation[1]);
  setText("turn-budget-elapsed", formatTurnBudgetDuration(elapsedMs));
  setText("turn-budget-remaining", formatTurnBudgetDuration(remainingMs));
  setText("turn-budget-stage", presentation[0]);
  setText("turn-budget-copy", active.source === "browser"
    ? "Bound to the current ChatGPT assistant turn through Equinox Browser."
    : "Using first-Local-call fallback because browser turn identity is unavailable.");
}

function renderTurnBudget() {
  const draft = state.turnBudgetDraft || { enabled: true, cutoffMinutes: 22, fallbackResetMinutes: 5 };
  const enabled = $("turn-budget-enabled");
  const cutoff = $("turn-budget-cutoff");
  const fallbackReset = $("turn-budget-fallback-reset");
  const save = $("save-turn-budget-button");
  if (enabled) enabled.checked = draft.enabled !== false;
  if (cutoff) {
    cutoff.value = String(draft.cutoffMinutes || 22);
    cutoff.disabled = draft.enabled === false || state.turnBudgetBusy;
  }
  if (fallbackReset) {
    fallbackReset.value = String(draft.fallbackResetMinutes || 5);
    fallbackReset.max = String(draft.cutoffMinutes || 22);
    fallbackReset.disabled = draft.enabled === false || state.turnBudgetBusy;
  }
  if (enabled) enabled.disabled = state.turnBudgetBusy;
  if (save) {
    save.disabled = state.turnBudgetBusy || !state.turnBudgetDirty;
    save.textContent = localizeUiText(state.turnBudgetBusy ? "Saving…" : "Save Turn Budget");
  }
  renderTurnBudgetLive();
}

function renderAgentControl() {
  const control = state.status?.agentControl || {};
  const paused = control.paused === true || control.state === "PAUSED";
  const activeWork = control.activeWork || {};
  $("agent-pause-banner").hidden = !paused;
  setBadge("agent-control-badge", paused ? "Paused" : "Active", paused ? "warn" : "good");
  setText(
    "agent-control-copy",
    paused
      ? "Agent mutations are paused. Read-only status remains available until you resume."
      : "Agent mutations are active. Emergency Stop is available from the top bar at any time.",
  );
  setText("active-terminal-count", String(activeWork.terminals ?? 0));
  setText("active-process-count", String(activeWork.processes ?? 0));
  setText("active-work-count", String(activeWork.total ?? 0));
  renderTurnBudget();

  const button = $("agent-control-button");
  if (!button) return;
  button.disabled = state.agentControlBusy || !state.status?.server?.pid;
  button.className = paused ? "button primary compact" : "button danger compact";
  button.textContent = localizeUiText(
    state.agentControlBusy
      ? (paused ? "Resuming agent…" : "Stopping agent…")
      : (paused ? "Resume agent" : "Emergency stop"),
  );
}

function renderRuntimeRestartControl() {
  const button = $("restart-runtime-button");
  if (!button) return;
  button.disabled = state.restartBusy || !state.status?.server?.pid;
  button.textContent = localizeUiText(state.restartBusy ? "Restarting…" : "Restart");
}

function taskStatusPresentation(status) {
  if (status === "active") return { label: "Active", tone: "good" };
  if (status === "completed") return { label: "Completed", tone: "neutral" };
  if (status === "cancelled") return { label: "Cancelled", tone: "bad" };
  return { label: String(status || "Unknown"), tone: "neutral" };
}

function continuationPresentation(continuation) {
  if (!continuation) return { label: "Not armed", tone: "neutral" };
  const map = {
    armed: ["Waiting", "warn"], delivering: ["Delivering", "warn"], delivered: ["Delivered", "good"],
    cancelled: ["Cancelled", "neutral"], expired: ["Expired", "neutral"], failed: ["Failed", "bad"],
  };
  const item = map[continuation.status] || [String(continuation.status || "Not armed"), "neutral"];
  return { label: item[0], tone: item[1] };
}

function taskTargetLabel(continuation) {
  const target = continuation?.target;
  if (!target) return localizeUiText("No browser target");
  const context = target.browserContext === "agent" ? "Agent Browser" : "Your Browser";
  return `${localizeUiText(context)} · ${String(target.title || "ChatGPT").slice(0, 72)}`;
}

function freshResumeReasonMessage(freshResume) {
  const reason = String(freshResume?.reason || "");
  if (freshResume?.status === "ambiguous") {
    if (reason.includes("runtime_restart")) return "Equinox restarted after browser mutation started, so the handoff could not be proven. It will not retry automatically.";
    if (reason.includes("emergency_stop")) return "Emergency Stop interrupted the handoff after browser mutation started. Equinox will not retry it automatically.";
    if (reason === "resume_guard_failed") return "A safety guard stopped the handoff after browser mutation started. Equinox will not retry it automatically.";
    if (reason.startsWith("browser_")) return "The browser handoff could not be confirmed. Equinox will not retry it automatically.";
    return "The fresh-chat handoff became uncertain after browser mutation started. Equinox will not retry it automatically.";
  }
  if (freshResume?.status === "cancelled") {
    if (reason === "emergency_stop") return "Emergency Stop cancelled the handoff before browser mutation. The saved checkpoint is still available.";
    if (reason === "checkpoint_changed") return "The task checkpoint changed, so the pending fresh-chat handoff was cancelled. The latest checkpoint is ready to continue.";
    return "The fresh-chat handoff was cancelled before browser mutation. The saved checkpoint is still available.";
  }
  return "";
}

function freshResumeRecoveryPresentation(freshResume) {
  if (!freshResume || freshResume.status === "confirmed") return null;
  if (freshResume.status === "prepared") return {
    label: "Waiting", tone: "warn", title: "Fresh-chat handoff is waiting",
    message: "Equinox will move this task after the current assistant turn finishes. You can cancel the handoff before browser mutation starts.",
    blocking: false, cancel: true, abandon: false,
  };
  if (freshResume.status === "creating") return {
    label: "In progress", tone: "warn", title: "Fresh-chat handoff is in progress",
    message: "Browser mutation has started. Equinox will not start another handoff while this transition is unresolved. Use Emergency Stop if you need to interrupt it.",
    blocking: true, cancel: false, abandon: false,
  };
  if (freshResume.status === "ambiguous") return {
    label: "Needs attention", tone: "bad", title: "Fresh-chat handoff needs attention",
    message: freshResumeReasonMessage(freshResume), blocking: true, cancel: false, abandon: true,
  };
  if (freshResume.status === "cancelled") return {
    label: "Recoverable", tone: "warn", title: "Fresh-chat handoff stopped",
    message: freshResumeReasonMessage(freshResume), blocking: false, cancel: false, abandon: false,
  };
  return null;
}

function taskLines(value) {
  return String(value || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function formatTaskReferences(references) {
  return (Array.isArray(references) ? references : []).map((item) => `${item.type} | ${item.label} | ${item.value}`).join("\n");
}

function parseTaskReferences(value) {
  const allowed = new Set(["project", "branch", "commit", "file", "url", "note"]);
  return taskLines(value).map((line, index) => {
    const parts = line.split("|");
    if (parts.length < 3) throw new Error(`Reference line ${index + 1} must use: type | label | value.`);
    const type = parts.shift().trim().toLowerCase();
    const label = parts.shift().trim();
    const referenceValue = parts.join("|").trim();
    if (!allowed.has(type) || !label || !referenceValue) throw new Error(`Reference line ${index + 1} is invalid.`);
    return { type, label, value: referenceValue };
  });
}

function replaceTaskInState(task) {
  const index = state.tasks.findIndex((item) => item.taskId === task.taskId);
  if (index >= 0) state.tasks[index] = clone(task);
  else state.tasks.unshift(clone(task));
  state.selectedTaskId = task.taskId;
  state.taskDraft = clone(task);
  state.taskDraftDirty = false;
}

function renderTasks() {
  const list = $("task-list");
  if (!list) return;
  list.replaceChildren();
  setText("task-count-label", `${state.tasks.length} tasks`);

  if (!state.tasks.length) {
    const empty = document.createElement("p");
    empty.className = "task-list-empty";
    empty.textContent = localizeUiText("No Task Capsules yet. Tasks appear here after an agent saves a checkpoint.");
    list.append(empty);
    state.selectedTaskId = null;
    state.taskDraft = null;
    state.taskDraftDirty = false;
  } else if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
    state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0].taskId;
    state.taskDraft = clone(state.tasks.find((task) => task.taskId === state.selectedTaskId));
    state.taskDraftDirty = false;
  }

  for (const task of state.tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-list-item${task.taskId === state.selectedTaskId ? " is-selected" : ""}`;
    button.dataset.taskId = task.taskId;
    button.disabled = state.taskBusy;
    button.setAttribute("aria-pressed", task.taskId === state.selectedTaskId ? "true" : "false");

    const title = document.createElement("span");
    title.className = "task-list-title";
    title.textContent = task.title;
    button.append(title);

    const taskId = document.createElement("code");
    taskId.className = "task-list-id";
    taskId.textContent = task.taskId;
    button.append(taskId);

    const meta = document.createElement("span");
    meta.className = "task-list-meta";
    const status = taskStatusPresentation(task.status);
    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${status.tone}`;
    statusBadge.textContent = localizeUiText(status.label);
    meta.append(statusBadge, document.createTextNode(`R${task.checkpointRevision} · ${formatDate(task.updatedAt)}`));
    button.append(meta);

    const continuation = continuationPresentation(task.continuation);
    const continuationLine = document.createElement("span");
    continuationLine.className = "task-list-continuation";
    const continuationBadge = document.createElement("span");
    continuationBadge.className = `badge ${continuation.tone}`;
    continuationBadge.textContent = localizeUiText(continuation.label);
    continuationLine.append(continuationBadge);
    if (task.continuation?.target) continuationLine.append(document.createTextNode(taskTargetLabel(task.continuation)));
    button.append(continuationLine);

    const recovery = freshResumeRecoveryPresentation(task.freshResume);
    if (recovery) {
      const recoveryLine = document.createElement("span");
      recoveryLine.className = "task-list-recovery";
      const recoveryBadge = document.createElement("span");
      recoveryBadge.className = `badge ${recovery.tone}`;
      recoveryBadge.textContent = localizeUiText(recovery.label);
      recoveryLine.append(recoveryBadge, document.createTextNode(localizeUiText(recovery.title)));
      button.append(recoveryLine);
    }
    list.append(button);
  }

  const task = state.taskDraft?.taskId === state.selectedTaskId ? state.taskDraft : null;
  $("task-detail-empty").hidden = Boolean(task);
  $("task-form").hidden = !task;
  if (!task) return;

  const status = taskStatusPresentation(task.status);
  const continuation = continuationPresentation(task.continuation);
  const recovery = freshResumeRecoveryPresentation(task.freshResume);
  setText("task-detail-title", task.title);
  setBadge("task-status-badge", status.label, status.tone);
  setText("task-detail-id", task.taskId);
  setText("task-detail-meta", `Checkpoint ${task.checkpointRevision} · Updated ${formatDate(task.updatedAt)}`);
  setText("task-continuation-state", continuation.label);
  setText("task-continuation-target", taskTargetLabel(task.continuation));

  const recoveryPanel = $("task-recovery-panel");
  recoveryPanel.hidden = !recovery;
  if (recovery) {
    setBadge("task-recovery-badge", recovery.label, recovery.tone);
    setText("task-recovery-title", recovery.title);
    setText("task-recovery-message", recovery.message);
    const reasonCode = String(task.freshResume?.reason || "");
    const code = $("task-recovery-code");
    code.hidden = !reasonCode;
    code.textContent = reasonCode ? `Reason: ${reasonCode}` : "";
    $("task-cancel-fresh-resume-button").hidden = !recovery.cancel;
    $("task-abandon-fresh-resume-button").hidden = !recovery.abandon;
  } else {
    $("task-cancel-fresh-resume-button").hidden = true;
    $("task-abandon-fresh-resume-button").hidden = true;
  }

  if (!state.taskDraftDirty) {
    $("task-title-input").value = task.title || "";
    $("task-objective-input").value = task.objective || "";
    $("task-completed-input").value = (task.completed || []).join("\n");
    $("task-next-input").value = (task.next || []).join("\n");
    $("task-references-input").value = formatTaskReferences(task.references);
  }

  const editable = task.status === "active" && !state.taskBusy && !recovery?.blocking;
  for (const id of ["task-title-input", "task-objective-input", "task-completed-input", "task-next-input", "task-references-input"]) $(id).disabled = !editable;
  $("task-save-button").disabled = !editable;
  $("task-complete-button").disabled = !editable;
  $("task-cancel-button").disabled = !editable;
  const deletable = task.status === "completed" || task.status === "cancelled";
  $("task-delete-button").hidden = !deletable;
  $("task-delete-button").disabled = state.taskBusy || !deletable;
  $("task-cancel-continuation-button").disabled = !editable || task.continuation?.status !== "armed";
  $("task-cancel-fresh-resume-button").disabled = state.taskBusy || task.status !== "active" || task.freshResume?.status !== "prepared";
  $("task-abandon-fresh-resume-button").disabled = state.taskBusy || task.status !== "active" || task.freshResume?.status !== "ambiguous";
  $("task-readonly-note").hidden = task.status === "active";
}

async function selectTask(taskId) {
  if (state.taskBusy || !/^task-[a-z0-9-]{6,80}$/u.test(String(taskId || ""))) return;
  state.taskBusy = true;
  state.taskDraftDirty = false;
  renderTasks();
  try {
    const result = await requestJson(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    replaceTaskInState(result.task);
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    state.taskBusy = false;
    renderTasks();
  }
}

async function saveSelectedTask(event) {
  event.preventDefault();
  const task = state.taskDraft;
  if (!task || task.status !== "active" || state.taskBusy) return;
  let references;
  try { references = parseTaskReferences($("task-references-input").value); }
  catch (error) { showError(error); return; }
  const payload = {
    expectedRevision: task.checkpointRevision,
    title: $("task-title-input").value,
    objective: $("task-objective-input").value,
    completed: taskLines($("task-completed-input").value),
    next: taskLines($("task-next-input").value),
    references,
  };
  state.taskBusy = true;
  renderTasks();
  try {
    const result = await mutationJson(`/api/v1/tasks/${encodeURIComponent(task.taskId)}`, "PUT", payload);
    replaceTaskInState(result.task);
    showToast("Task changes saved.");
    clearError();
  } catch (error) { showError(error); }
  finally { state.taskBusy = false; renderTasks(); }
}

async function deleteSelectedTask() {
  const task = state.taskDraft;
  if (!task || task.status === "active" || state.taskBusy) return;
  if (!window.confirm(localizeUiText("Delete this task permanently? This cannot be undone."))) return;
  state.taskBusy = true;
  renderTasks();
  try {
    await mutationJson(`/api/v1/tasks/${encodeURIComponent(task.taskId)}/delete`, "POST", {});
    state.tasks = state.tasks.filter((item) => item.taskId !== task.taskId);
    state.selectedTaskId = null;
    state.taskDraft = null;
    state.taskDraftDirty = false;
    const refreshed = await requestJson("/api/v1/tasks").catch(() => null);
    if (refreshed?.tasks) state.tasks = clone(refreshed.tasks);
    showToast("Task deleted.");
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    state.taskBusy = false;
    renderTasks();
  }
}

async function runTaskAction(action) {
  const task = state.taskDraft;
  if (!task || task.status !== "active" || state.taskBusy) return;
  if (action === "complete" && !window.confirm(localizeUiText("Mark this task complete?"))) return;
  if (action === "cancel" && !window.confirm(localizeUiText("Cancel this task?"))) return;
  if (action === "fresh-abandon" && !window.confirm(localizeUiText("Clear this blocked fresh-chat transition? This does not retry the browser action."))) return;
  const paths = {
    complete: "complete", cancel: "cancel", continuation: "continuation/cancel",
    "fresh-cancel": "fresh-resume/cancel", "fresh-abandon": "fresh-resume/abandon",
  };
  const messages = {
    complete: "Task marked complete.", cancel: "Task cancelled.", continuation: "Continuation cancelled.",
    "fresh-cancel": "Fresh-chat handoff cancelled.",
    "fresh-abandon": "Blocked transition cleared. Continue from the saved checkpoint in ChatGPT.",
  };
  if (!paths[action]) return;
  state.taskBusy = true;
  renderTasks();
  try {
    const result = await mutationJson(`/api/v1/tasks/${encodeURIComponent(task.taskId)}/${paths[action]}`, "POST", {});
    replaceTaskInState(result.task);
    showToast(messages[action]);
    clearError();
  } catch (error) { showError(error); }
  finally { state.taskBusy = false; renderTasks(); }
}

function renderAll() {
  renderDashboard();
  renderOnboarding();
  renderDoctor();
  renderUpdate();
  renderProjects();
  renderTasks();
  renderPermissions();
  renderUninstall();
  renderIntegrations();
  renderBrowserPage();
  renderActivity();
  renderAgentControl();
  renderRuntimeRestartControl();
}

function updateRestartState() {
  $("restart-banner").hidden = !state.restartRequired;
  $("refresh-button").disabled = state.restartRequired || state.restartBusy;
  setConfigEditingEnabled(!state.restartRequired);
  renderRuntimeRestartControl();
}

async function refreshAll() {
  if (state.restartRequired || state.refreshAllBusy) return;
  state.refreshAllBusy = true;
  clearError();
  $("refresh-button").disabled = true;
  try {
    const [health, status, config, activity, tasks, update, onboarding, doctor, doctorRepairs, peekaboo, telegram, webFileTransfer, httpProfiles] = await Promise.all([
      requestJson("/api/v1/health"),
      requestJson("/api/v1/status"),
      requestJson("/api/v1/config"),
      requestJson("/api/v1/activity").catch(() => ({ events: [] })),
      requestJson("/api/v1/tasks").catch(() => ({ tasks: [] })),
      requestJson("/api/v1/update"),
      requestJson("/api/v1/onboarding"),
      requestJson("/api/v1/doctor").catch(() => ({ doctor: null })),
      requestJson("/api/v1/doctor/repairs").catch(() => ({ repairs: null })),
      requestJson("/api/v1/integrations/peekaboo").catch(() => ({ peekaboo: null })),
      requestJson("/api/v1/integrations/telegram").catch(() => ({ telegram: null })),
      requestJson("/api/v1/files/import-settings").catch(() => ({ webFileTransfer: null })),
      requestJson("/api/v1/integrations/http-profiles").catch(() => ({ httpProfiles: null })),
    ]);
    state.health = health;
    state.status = status.status;
    state.turnBudget = status.status?.turnBudget || null;
    if (!state.turnBudgetDirty && state.turnBudget) {
      state.turnBudgetDraft = {
        enabled: state.turnBudget.enabled !== false,
        cutoffMinutes: Number(state.turnBudget.cutoffMinutes) || 22,
        fallbackResetMinutes: Number(state.turnBudget.fallbackResetMinutes) || 5,
      };
    }
    state.config = clone(config.config);
    state.revision = config.revision;
    state.activity = Array.isArray(activity.events) ? activity.events : [];
    state.tasks = Array.isArray(tasks.tasks) ? tasks.tasks : [];
    if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
      state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0]?.taskId || null;
      state.taskDraftDirty = false;
    }
    if (!state.taskDraftDirty) {
      state.taskDraft = state.selectedTaskId ? clone(state.tasks.find((task) => task.taskId === state.selectedTaskId)) : null;
    }
    state.update = update.update || null;
    state.onboarding = onboarding.onboarding || null;
    state.doctor = doctor.doctor || null;
    state.doctorRepairs = doctorRepairs.repairs || null;
    if (peekaboo.peekaboo) {
      state.status = {
        ...(state.status || {}),
        peekaboo: peekaboo.peekaboo,
      };
    }
    state.telegram = telegram.telegram || null;
    state.webFileTransfer = webFileTransfer.webFileTransfer || null;
    state.httpProfiles = httpProfiles.httpProfiles || null;
    if (!state.browserSettingsDirty) state.browserDraft = null;
    state.restartRequired = false;
    markClean();
    renderAll();
    document.body.classList.remove("control-loading");
    state.lastRefreshedAt = new Date();
    renderLastRefreshed();
  } catch (error) {
    showError(error);
  } finally {
    state.refreshAllBusy = false;
    $("refresh-button").disabled = state.restartRequired || state.restartBusy;
  }
}

function autoRefreshAllowed() {
  return !document.hidden && !state.restartRequired && !state.restartBusy && !state.refreshAllBusy;
}

function reconcileLiveTasks(nextTasks) {
  state.tasks = Array.isArray(nextTasks) ? clone(nextTasks) : [];
  if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
    state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0]?.taskId || null;
    state.taskDraftDirty = false;
  }
  if (!state.taskDraftDirty && !state.taskBusy) {
    state.taskDraft = state.selectedTaskId ? clone(state.tasks.find((task) => task.taskId === state.selectedTaskId)) : null;
  }
}

async function refreshLiveState() {
  if (!autoRefreshAllowed() || state.autoRefreshLiveBusy || state.onboardingBusy) return;
  state.autoRefreshLiveBusy = true;
  try {
    const [health, status, activity, tasks, onboarding] = await Promise.all([
      requestJson("/api/v1/health", { backgroundRefresh: true }),
      requestJson("/api/v1/status", { backgroundRefresh: true }),
      requestJson("/api/v1/activity", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/tasks", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/onboarding", { backgroundRefresh: true }).catch(() => null),
    ]);
    state.health = health;
    const previousStatus = state.status || {};
    state.status = {
      ...previousStatus,
      ...status.status,
      peekaboo: {
        ...(previousStatus.peekaboo || {}),
        ...(status.status?.peekaboo || {}),
      },
    };
    state.turnBudget = status.status?.turnBudget || state.turnBudget;
    if (!state.turnBudgetDirty && state.turnBudget) {
      state.turnBudgetDraft = {
        enabled: state.turnBudget.enabled !== false,
        cutoffMinutes: Number(state.turnBudget.cutoffMinutes) || 22,
        fallbackResetMinutes: Number(state.turnBudget.fallbackResetMinutes) || 5,
      };
    }
    if (activity?.events) state.activity = activity.events;
    if (tasks?.tasks) reconcileLiveTasks(tasks.tasks);
    if (onboarding?.onboarding) state.onboarding = onboarding.onboarding;
    renderDashboard();
    renderOnboarding();
    renderTasks();
    renderActivity();
    renderBrowserPage();
    renderAgentControl();
    renderRuntimeRestartControl();
    renderTurnBudget();
    state.lastRefreshedAt = new Date();
    renderLastRefreshed();
  } catch {
    // Automatic polling is best-effort. Manual Refresh remains the explicit error surface.
  } finally {
    state.autoRefreshLiveBusy = false;
  }
}

async function refreshMediumState() {
  if (!autoRefreshAllowed() || state.autoRefreshMediumBusy) return;
  state.autoRefreshMediumBusy = true;
  try {
    const [doctor, doctorRepairs, peekaboo, telegram, webFileTransfer, httpProfiles] = await Promise.all([
      requestJson("/api/v1/doctor", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/doctor/repairs", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/integrations/peekaboo", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/integrations/telegram", { backgroundRefresh: true }).catch(() => null),
      requestJson("/api/v1/files/import-settings", { backgroundRefresh: true }).catch(() => null),
      state.httpProfileDraft ? Promise.resolve(null) : requestJson("/api/v1/integrations/http-profiles", { backgroundRefresh: true }).catch(() => null),
    ]);
    if (doctor?.doctor) state.doctor = doctor.doctor;
    if (doctorRepairs?.repairs) state.doctorRepairs = doctorRepairs.repairs;
    if (peekaboo?.peekaboo) {
      state.status = { ...(state.status || {}), peekaboo: peekaboo.peekaboo };
    }
    if (telegram?.telegram) state.telegram = telegram.telegram;
    if (webFileTransfer?.webFileTransfer) state.webFileTransfer = webFileTransfer.webFileTransfer;
    if (httpProfiles?.httpProfiles && !state.httpProfileDraft) state.httpProfiles = httpProfiles.httpProfiles;
    renderDoctor();
    if (!state.httpProfileDraft) renderIntegrations();
    renderBrowserPage();
    renderDashboard();
  } catch {
    // Best-effort background refresh; do not interrupt the user for transient failures.
  } finally {
    state.autoRefreshMediumBusy = false;
  }
}

async function refreshSlowState() {
  if (!autoRefreshAllowed() || state.autoRefreshSlowBusy) return;
  state.autoRefreshSlowBusy = true;
  try {
    const [config, update] = await Promise.all([
      state.dirty || state.dialogMode ? Promise.resolve(null) : requestJson("/api/v1/config", { backgroundRefresh: true }).catch(() => null),
      state.updateBusy || state.updateApplyBusy ? Promise.resolve(null) : requestJson("/api/v1/update", { backgroundRefresh: true }).catch(() => null),
    ]);
    if (config?.config && !state.dirty && !state.dialogMode) {
      state.config = clone(config.config);
      state.revision = config.revision;
      renderProjects();
      renderPermissions();
    }
    if (update?.update && !state.updateBusy && !state.updateApplyBusy) {
      state.update = update.update;
      renderUpdate();
    }
  } catch {
    // Best-effort background refresh; manual Refresh can surface persistent errors.
  } finally {
    state.autoRefreshSlowBusy = false;
  }
}

function refreshVisibleControlCenter() {
  if (document.hidden) return;
  const now = Date.now();
  if (now - state.lastAutoRefreshAt < AUTO_REFRESH_FOCUS_DEBOUNCE_MS) return;
  state.lastAutoRefreshAt = now;
  void refreshLiveState();
  void refreshMediumState();
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

function selectBrowserSettingsTarget(value) {
  if (state.browserSettingsBusy || !["agent", "user"].includes(value)) return;
  state.browserSettingsTarget = value;
  state.browserDraft = null;
  state.browserSettingsDirty = false;
  renderBrowserPage();
}

function updateBrowserDraftFromInputs() {
  const baseline = browserSettingsFromStatus(state.browserSettingsTarget);
  if (!baseline || state.browserSettingsBusy) return;
  state.browserDraft = {
    context: state.browserSettingsTarget,
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

async function openAgentBrowserFromControlCenter() {
  if (state.agentBrowserBusy) return;
  clearError();
  state.agentBrowserBusy = true;
  renderBrowserPage();
  try {
    const result = await mutationJson("/api/v1/browser/agent/open", "POST", {});
    state.status = state.status || {};
    state.status.browser = {
      ...(state.status.browser || {}),
      agentBrowser: result.agentBrowser || state.status.browser?.agentBrowser || null,
    };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Agent Browser opened.");
    setTimeout(() => void refreshAll(), 900);
  } catch (error) {
    showError(error);
  } finally {
    state.agentBrowserBusy = false;
    renderBrowserPage();
    renderIntegrations();
  }
}

async function saveBrowserSettings() {
  if (!state.browserDraft || !state.browserSettingsDirty || state.browserSettingsBusy) return;
  clearError();
  state.browserSettingsBusy = true;
  renderBrowserPage();
  try {
    const target = state.browserDraft.context;
    const result = await mutationJson("/api/v1/browser/settings", "PUT", state.browserDraft);
    const settings = result.settings || {};
    const browser = state.status?.browser || {};
    const previousContext = browser.contexts?.[target] || {};
    const updatedContext = {
      ...previousContext,
      ready: true,
      controlEnabled: typeof settings.enabled === "boolean" ? settings.enabled : state.browserDraft.enabled,
      agentCursorEnabled: typeof settings.agentCursorEnabled === "boolean" ? settings.agentCursorEnabled : state.browserDraft.agentCursorEnabled,
      agentCursorName: typeof settings.agentCursorName === "string" ? settings.agentCursorName : state.browserDraft.agentCursorName,
    };
    state.status.browser = {
      ...browser,
      contexts: {
        ...(browser.contexts || {}),
        [target]: updatedContext,
      },
    };
    if (target === "user") {
      state.status.browser = {
        ...state.status.browser,
        controlEnabled: updatedContext.controlEnabled,
        agentCursorEnabled: updatedContext.agentCursorEnabled,
        agentCursorName: updatedContext.agentCursorName,
        nativeHostConnected: Boolean(settings.nativeHostConnected ?? browser.nativeHostConnected),
        localConnected: Boolean(settings.localConnected ?? browser.localConnected),
      };
    }
    state.browserDraft = browserSettingsFromStatus(target);
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

async function startTelegramPairingUi() {
  if (state.integrationBusy || !state.telegramBotToken.trim()) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  renderOnboarding();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/pair/start", "POST", {
      botToken: state.telegramBotToken.trim(),
    });
    state.telegram = { ...(state.telegram || {}), configured: false, ready: false, needsAttention: false, pairing: result.pairing };
    state.telegramBotToken = "";
    if ($("setup-telegram-token")) $("setup-telegram-token").value = "";
    state.telegramSetupSkipped = false;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram pairing started. Send /start to your bot.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
    renderOnboarding();
  }
}

async function refreshTelegramPairing() {
  const pairing = state.telegram?.pairing;
  if (document.hidden || state.telegramPairingPollBusy || !pairing?.active || pairing.candidateFound) return;
  state.telegramPairingPollBusy = true;
  try {
    const result = await requestJson("/api/v1/integrations/telegram/pair", { backgroundRefresh: true });
    state.telegram = { ...(state.telegram || {}), pairing: result.pairing };
    renderIntegrations();
    renderOnboarding();
  } catch {
    // Pairing polling is best-effort; explicit actions remain the error surface.
  } finally {
    state.telegramPairingPollBusy = false;
  }
}

async function confirmTelegramPairingUi() {
  if (state.integrationBusy || !state.telegram?.pairing?.candidateFound) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  renderOnboarding();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/pair/confirm", "POST", {});
    state.telegram = { ...(result.telegram || {}), pairing: { active: false, candidateFound: false }, pendingInboundCount: 0 };
    state.telegramSetupSkipped = false;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram paired successfully.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
    renderOnboarding();
  }
}

async function cancelTelegramPairingUi() {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  try {
    await mutationJson("/api/v1/integrations/telegram/pair/cancel", "POST", {});
    state.telegram = { ...(state.telegram || {}), configured: false, ready: false, needsAttention: false, pairing: { active: false, candidateFound: false } };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram pairing cancelled.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
    renderOnboarding();
  }
}

async function changeWebImportFolder() {
  if (state.integrationBusy || state.pickerBusy) return;
  clearError(); state.integrationBusy = true; state.pickerBusy = true; renderIntegrations();
  try {
    const picked = await mutationJson("/api/v1/folder-picker", "POST", {});
    if (picked.cancelled) return showToast("Folder selection cancelled.");
    const result = await mutationJson("/api/v1/files/import-settings", "PUT", { path: picked.path });
    state.webFileTransfer = result.webFileTransfer;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Web file transfer folder updated.");
  } catch (error) { showError(error); } finally { state.pickerBusy = false; state.integrationBusy = false; renderIntegrations(); }
}

async function resetWebImportFolder() {
  if (state.integrationBusy || state.pickerBusy || state.webFileTransfer?.isDefault) return;
  clearError(); state.integrationBusy = true; renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/files/import-settings", "PUT", { path: null });
    state.webFileTransfer = result.webFileTransfer;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Web file transfer folder reset to default.");
  } catch (error) { showError(error); } finally { state.integrationBusy = false; renderIntegrations(); }
}

async function changeTelegramDownloadFolder() {
  if (state.integrationBusy || state.pickerBusy) return;
  clearError();
  state.pickerBusy = true;
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const picked = await mutationJson("/api/v1/folder-picker", "POST", {});
    if (picked.cancelled) return showToast("Folder selection cancelled.");
    if (typeof picked.path !== "string" || !picked.path.startsWith("/")) throw new Error("Folder picker returned an invalid path.");
    const result = await mutationJson("/api/v1/integrations/telegram/downloads", "PUT", { path: picked.path });
    state.telegram = { ...(state.telegram || {}), downloads: result.downloads };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram download folder updated.");
  } catch (error) {
    showError(error);
  } finally {
    state.pickerBusy = false;
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function resetTelegramDownloadFolder() {
  if (state.integrationBusy || state.pickerBusy || state.telegram?.downloads?.isDefault) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/downloads", "PUT", { path: null });
    state.telegram = { ...(state.telegram || {}), downloads: result.downloads };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram download folder reset to default.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function updateTelegramRemoteControlUi(enabled) {
  if (state.integrationBusy) return;
  clearError();
  state.integrationBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/telegram/remote-control", "PUT", { enabled: Boolean(enabled) });
    state.telegram = { ...(state.telegram || {}), remoteControl: result.remoteControl };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast(enabled ? "Telegram remote control enabled." : "Telegram remote control disabled.");
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
    state.telegram = { configured: false, ready: false, needsAttention: false, userIdHint: null, pairing: { active: false, candidateFound: false }, pendingInboundCount: 0 };
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Telegram disconnected.");
  } catch (error) {
    showError(error);
  } finally {
    state.integrationBusy = false;
    renderIntegrations();
  }
}

async function refreshHttpProfiles() {
  const result = await requestJson("/api/v1/integrations/http-profiles");
  state.httpProfiles = result.httpProfiles || { agentProfileManagementEnabled: true, profiles: [] };
  return state.httpProfiles;
}

async function updateHttpProfileManagement(enabled) {
  if (state.httpProfileBusy) return;
  clearError();
  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    const result = await mutationJson("/api/v1/integrations/http-profiles/management", "PUT", { enabled });
    state.httpProfiles = result.httpProfiles || state.httpProfiles;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("HTTP profile management updated.");
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}

function linesFromField(value) {
  return String(value || "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function saveHttpProfile(form) {
  if (state.httpProfileBusy) return;
  clearError();
  const data = new FormData(form);
  const id = String(data.get("id") || "").trim();
  const label = String(data.get("label") || "").trim();
  const origin = String(data.get("origin") || "").trim();
  const basePath = String(data.get("basePath") || "").trim();
  const authType = String(data.get("authType") || "");
  const authHeader = String(data.get("authHeader") || "").trim();
  const allowedMethods = data.getAll("allowedMethod").map(String);
  const allowedPathPrefixes = linesFromField(data.get("allowedPathPrefixes"));
  const allowedAgentHeaders = linesFromField(data.get("allowedAgentHeaders"));
  const timeoutMs = Number.parseInt(String(data.get("timeoutMs") || ""), 10);
  const credential = String(data.get("credential") || "");

  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(id)) return showError(new Error("Profile ID must start with a lowercase letter and use only lowercase letters, numbers, dots, underscores or hyphens."));
  if (!label || label.length > 100) return showError(new Error("Display name must be 1-100 characters."));
  if (!origin.startsWith("https://")) return showError(new Error("HTTPS origin must start with https://."));
  if (!basePath.startsWith("/") || basePath.startsWith("//")) return showError(new Error("Base path must begin with exactly one /."));
  if (allowedMethods.length < 1) return showError(new Error("Choose at least one allowed method."));
  if (allowedPathPrefixes.length < 1) return showError(new Error("Add at least one allowed path prefix."));
  if (authType === "secret_header" && !authHeader) return showError(new Error("Secret header name is required."));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) return showError(new Error("Request timeout must be between 1000 and 30000 ms."));

  const profile = {
    id,
    label,
    origin,
    basePath,
    auth: authType === "secret_header" ? { type: "secret_header", headerName: authHeader } : { type: "bearer" },
    allowedMethods,
    allowedPathPrefixes,
    allowedAgentHeaders,
    timeoutMs,
  };

  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/http-profiles/profile", "PUT", {
      profile,
      ...(credential ? { credential } : {}),
    });
    await refreshHttpProfiles();
    state.httpProfileDraft = null;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Profile saved.");
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}

async function testHttpProfileConnection(profile) {
  if (state.httpProfileBusy || !profile?.ready) return;
  clearError();
  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    const method = profile.allowedMethods?.includes("GET") ? "GET" : profile.allowedMethods?.[0];
    const path = profile.allowedPathPrefixes?.[0] || "/";
    const response = await mutationJson("/api/v1/integrations/http-profiles/test", "POST", {
      profileId: profile.id,
      method,
      path,
      query: {},
      headers: {},
    });
    const result = response.result || {};
    state.httpProfileTestResults[profile.id] = `HTTP ${result.status ?? 0} · ${result.durationMs ?? 0} ms`;
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast(`HTTP test returned status ${result.status ?? 0}.`);
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
    renderIntegrations();
  }
}

async function deleteHttpProfileFromControlCenter(profile) {
  if (state.httpProfileBusy || !profile?.id) return;
  if (!window.confirm(localizeUiText("Delete this HTTP profile and its saved credential?"))) return;
  clearError();
  state.httpProfileBusy = true;
  renderIntegrations();
  try {
    await mutationJson("/api/v1/integrations/http-profiles/delete", "POST", { profileId: profile.id });
    await refreshHttpProfiles();
    if (state.httpProfileDraft?.id === profile.id) state.httpProfileDraft = null;
    delete state.httpProfileTestResults[profile.id];
    if (state.health?.controlCenter) state.health.controlCenter.mutationCount += 1;
    showToast("Profile deleted.");
  } catch (error) {
    showError(error);
  } finally {
    state.httpProfileBusy = false;
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
      requestJson("/api/v1/doctor").catch(() => ({ doctor: null })),
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

async function toggleAgentControl() {
  if (state.agentControlBusy || !state.status?.server?.pid) return;
  clearError();
  const paused = state.status?.agentControl?.paused === true || state.status?.agentControl?.state === "PAUSED";
  state.agentControlBusy = true;
  renderAgentControl();
  try {
    const endpoint = paused ? "/api/v1/agent/resume" : "/api/v1/agent/pause";
    const response = await mutationJson(endpoint, "POST", {});
    state.status = {
      ...(state.status || {}),
      agentControl: response.agentControl || {},
    };
    showToast(paused ? "Agent resumed." : "Emergency Stop activated. Agent mutations are paused.");
    const refreshedStatus = await requestJson("/api/v1/status").catch(() => null);
    if (refreshedStatus?.status) state.status = refreshedStatus.status;
    const activity = await requestJson("/api/v1/activity").catch(() => null);
    if (activity?.events) state.activity = activity.events;
    const tasks = await requestJson("/api/v1/tasks").catch(() => null);
    if (tasks?.tasks) {
      state.tasks = tasks.tasks;
      if (!state.selectedTaskId || !state.tasks.some((task) => task.taskId === state.selectedTaskId)) {
        state.selectedTaskId = state.tasks.find((task) => task.status === "active")?.taskId || state.tasks[0]?.taskId || null;
      }
      state.taskDraft = state.selectedTaskId ? clone(state.tasks.find((task) => task.taskId === state.selectedTaskId)) : null;
    }
  } catch (error) {
    showError(error);
  } finally {
    state.agentControlBusy = false;
    renderAll();
  }
}

async function saveTurnBudgetSettings() {
  if (state.turnBudgetBusy || !state.turnBudgetDraft) return;
  const cutoffMinutes = Number(state.turnBudgetDraft.cutoffMinutes);
  const fallbackResetMinutes = Number(state.turnBudgetDraft.fallbackResetMinutes);
  if (!Number.isInteger(cutoffMinutes) || cutoffMinutes < 5 || cutoffMinutes > 120) {
    showError(new Error("Turn Budget cutoff must be an integer between 5 and 120 minutes."));
    return;
  }
  if (!Number.isInteger(fallbackResetMinutes) || fallbackResetMinutes < 1 || fallbackResetMinutes > cutoffMinutes) {
    showError(new Error("Fallback idle timeout must be an integer between 1 minute and the safety cutoff."));
    return;
  }
  clearError();
  state.turnBudgetBusy = true;
  renderTurnBudget();
  try {
    const response = await mutationJson("/api/v1/turn-budget", "PUT", {
      enabled: state.turnBudgetDraft.enabled !== false,
      cutoffMinutes,
      fallbackResetMinutes,
    });
    state.turnBudget = response.turnBudget;
    state.status = { ...(state.status || {}), turnBudget: response.turnBudget };
    state.turnBudgetDraft = { enabled: response.turnBudget.enabled !== false, cutoffMinutes: response.turnBudget.cutoffMinutes, fallbackResetMinutes: response.turnBudget.fallbackResetMinutes };
    state.turnBudgetDirty = false;
    showToast("Turn Budget updated immediately.");
  } catch (error) {
    showError(error);
  } finally {
    state.turnBudgetBusy = false;
    renderTurnBudget();
  }
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

  for (const button of document.querySelectorAll("[data-theme-value]")) {
    button.addEventListener("click", () => setTheme(button.dataset.themeValue));
  }
  systemThemeMedia.addEventListener?.("change", () => {
    if (state.theme === "system") applyTheme();
  });
  $("language-select").addEventListener("change", (event) => setLanguage(event.target.value));
  window.addEventListener("focus", refreshVisibleControlCenter);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshVisibleControlCenter();
  });
  $("agent-control-button").addEventListener("click", toggleAgentControl);
  $("turn-budget-enabled").addEventListener("change", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { cutoffMinutes: 22, fallbackResetMinutes: 5 }), enabled: event.target.checked };
    state.turnBudgetDirty = true;
    renderTurnBudget();
  });
  $("turn-budget-cutoff").addEventListener("input", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { enabled: true, fallbackResetMinutes: 5 }), cutoffMinutes: Number(event.target.value) };
    state.turnBudgetDirty = true;
    renderTurnBudget();
  });
  $("turn-budget-fallback-reset").addEventListener("input", (event) => {
    state.turnBudgetDraft = { ...(state.turnBudgetDraft || { enabled: true, cutoffMinutes: 22 }), fallbackResetMinutes: Number(event.target.value) };
    state.turnBudgetDirty = true;
    $("save-turn-budget-button").disabled = state.turnBudgetBusy;
  });
  $("save-turn-budget-button").addEventListener("click", saveTurnBudgetSettings);
  $("restart-runtime-button").addEventListener("click", restartRuntimeFromControlCenter);
  $("refresh-button").addEventListener("click", refreshAll);
  $("onboarding-tunnel-form").addEventListener("submit", submitTunnelOnboarding);
  $("copy-setup-tunnel-id").addEventListener("click", () => void copySetupText(state.onboarding?.tunnelId || "", "Tunnel ID copied."));
  $("copy-setup-test-prompt").addEventListener("click", () => void copySetupText($("setup-test-prompt").textContent.trim(), "Test prompt copied."));
  $("setup-telegram-token").addEventListener("input", (event) => { state.telegramBotToken = event.target.value; renderOnboarding(); });
  $("setup-telegram-start").addEventListener("click", () => void startTelegramPairingUi());
  $("setup-telegram-confirm").addEventListener("click", () => void confirmTelegramPairingUi());
  $("setup-telegram-cancel").addEventListener("click", () => void cancelTelegramPairingUi());
  $("setup-telegram-skip").addEventListener("click", () => { state.telegramSetupSkipped = true; renderOnboarding(); });
  $("setup-uninstall-nav").addEventListener("click", () => {
    const details = $("setup-uninstall-details");
    details.open = true;
    details.scrollIntoView({ block: "start", behavior: "smooth" });
  });
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
  $("task-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-task-id]");
    if (button) void selectTask(button.dataset.taskId);
  });
  $("task-form").addEventListener("submit", saveSelectedTask);
  for (const id of ["task-title-input", "task-objective-input", "task-completed-input", "task-next-input", "task-references-input"]) {
    $(id).addEventListener("input", () => { state.taskDraftDirty = true; });
  }
  $("task-cancel-continuation-button").addEventListener("click", () => void runTaskAction("continuation"));
  $("task-cancel-fresh-resume-button").addEventListener("click", () => void runTaskAction("fresh-cancel"));
  $("task-abandon-fresh-resume-button").addEventListener("click", () => void runTaskAction("fresh-abandon"));
  $("task-complete-button").addEventListener("click", () => void runTaskAction("complete"));
  $("task-cancel-button").addEventListener("click", () => void runTaskAction("cancel"));
  $("task-delete-button").addEventListener("click", () => void deleteSelectedTask());
  $("open-agent-browser-button").addEventListener("click", openAgentBrowserFromControlCenter);
  $("browser-settings-target").addEventListener("change", (event) => selectBrowserSettingsTarget(event.target.value));
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

function applyInitialNavigationIntent() {
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  const taskId = params.get("task");
  if (section && sectionMeta[section]) state.activeSection = section;
  if (taskId && /^task-[a-z0-9-]{6,80}$/u.test(taskId)) state.selectedTaskId = taskId;
}

applyInitialNavigationIntent();
captureStaticTranslatables();
applyTheme();
applyStaticLanguage();
notifyNativeLanguage();
bindEvents();
switchSection(state.activeSection);
renderLastRefreshed();
setInterval(renderTurnBudgetLive, 1_000);
setInterval(() => { void refreshLiveState(); }, AUTO_REFRESH_LIVE_MS);
setInterval(() => { void refreshMediumState(); }, AUTO_REFRESH_MEDIUM_MS);
setInterval(() => { void refreshTelegramPairing(); }, 2_500);
setInterval(() => { void refreshSlowState(); }, AUTO_REFRESH_SLOW_MS);
void refreshAll();
