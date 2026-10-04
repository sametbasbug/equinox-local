export const SUPPORTED_LANGUAGES = Object.freeze(["en", "tr"]);
const SUPPORTED_LANGUAGE_SET = new Set(SUPPORTED_LANGUAGES);

export function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGE_SET.has(value) ? value : "en";
}

export function localeForLanguage(language) {
  return normalizeLanguage(language) === "tr" ? "tr-TR" : "en-US";
}

const TR_UI = Object.freeze({
  "Getting started": "Başlarken",
  "Setup": "Kurulum",
  "Setup Equinox Local": "Equinox Local’i kur",
  "First-time setup": "İlk kurulum",
  "Connect ChatGPT to this computer": "ChatGPT’yi bu bilgisayara bağlayın",
  "Follow these steps once. Control Center unlocks after ChatGPT successfully reaches Equinox Local.": "Bu adımları bir kez tamamlayın. ChatGPT, Equinox Local’e başarıyla ulaştığında Kontrol Merkezi açılır.",
  "Setup in progress": "Kurulum sürüyor",
  "Equinox Local is installed": "Equinox Local kuruldu",
  "The private runtime and starter workspace are already on this computer.": "Özel runtime ve başlangıç çalışma alanı bu bilgisayarda hazır.",
  "Create the private OpenAI tunnel": "Özel OpenAI tunnel’ını oluşturun",
  "The Tunnel ID tells ChatGPT which Equinox Local runtime to reach. The Runtime API key lets this computer connect to that tunnel.": "Tunnel ID, ChatGPT’nin hangi Equinox Local runtime’ına ulaşacağını belirtir. Runtime API anahtarı bu bilgisayarın tunnel’a bağlanmasını sağlar.",
  "Not connected": "Bağlı değil",
  "Open Tunnels ↗": "Tunnels’ı aç ↗",
  "Open API keys ↗": "API anahtarlarını aç ↗",
  "Use the exact Tunnel ID you will also select in ChatGPT.": "ChatGPT’de de seçeceğiniz aynı Tunnel ID’yi kullanın.",
  "Stored privately on this computer. Do not use an admin key.": "Bu bilgisayarda özel olarak saklanır. Admin anahtarı kullanmayın.",
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
  "Verify ChatGPT → Local": "ChatGPT → Local bağlantısını doğrulayın",
  "Send one real tool request from ChatGPT. Setup stays locked until that request reaches this computer.": "ChatGPT’den gerçek bir araç isteği gönderin. Bu istek bu bilgisayara ulaşana kadar kurulum kilitli kalır.",
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
  "Setup complete. ChatGPT can now reach this computer.": "Kurulum tamamlandı. ChatGPT artık bu bilgisayara ulaşabiliyor.",
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
  "Paste both values below. The API key stays only on this computer and is never shown again.": "İki değeri de aşağıya yapıştırın. API anahtarı yalnızca bu bilgisayarda kalır ve tekrar gösterilmez.",
  "Open ChatGPT connector/app settings and start the custom MCP connection flow available to your account/workspace.": "ChatGPT bağlayıcı/uygulama ayarlarını açın ve hesabınızda/çalışma alanınızda bulunan özel MCP bağlantı akışını başlatın.",
  "Open the extension, review and accept the browser-data disclosure.": "Uzantıyı açın, tarayıcı verisi bilgilendirmesini inceleyip kabul edin.",
  "After the connector and browser extension are ready, paste this into ChatGPT:": "Bağlayıcı ve tarayıcı uzantısı hazır olduğunda bunu ChatGPT’ye yapıştırın:",
  "Install Equinox Browser in Your Browser and open the extension.": "Equinox Browser’ı kendi tarayıcınıza yükleyin ve uzantıyı açın.",
  "Equinox Browser is connected. Review and accept the browser-data disclosure in the extension.": "Equinox Browser bağlı. Uzantıdaki tarayıcı verisi bilgilendirmesini inceleyip kabul edin.",
  "Disclosure accepted. Turn Browser Control on to finish the required browser connection.": "Bilgilendirme kabul edildi. Gerekli tarayıcı bağlantısını tamamlamak için Browser Control’u açın.",
  "Equinox Browser is connected, consented and Browser Control is on.": "Equinox Browser bağlı, bilgilendirme kabul edildi ve Browser Control açık.",
  "Waiting for the first Equinox Local tool call from ChatGPT. This is the final setup check.": "ChatGPT’den ilk Equinox Local araç çağrısı bekleniyor. Bu son kurulum kontrolüdür.",
  "Finish the remaining steps. Setup unlocks only after a real ChatGPT tool request reaches this computer.": "Kalan adımları tamamlayın. Kurulum ancak ChatGPT’den gerçek bir araç isteği bu bilgisayara ulaştığında açılır.",
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
  "Your computer, connected": "Bilgisayarınız, bağlantıda",
  "Connected capabilities": "Bağlı araçlar",
  "On this computer": "Bu bilgisayarda",
  "ChatGPT to local computer connection": "ChatGPT ile yerel bilgisayar bağlantısı",
  "ChatGPT on the web": "ChatGPT web",
  "Tools on this computer": "Bu bilgisayardaki araçlar",
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
  "Your named projects and folders, saved privately on this computer.": "Bu bilgisayarda özel olarak saklanan proje ve klasör kısayollarınız.",
  "Access settings": "Erişim ayarları",
  "Review recent runtime events and configuration changes. Sensitive details are kept out of this timeline.": "Son çalışma olaylarını ve yapılandırma değişikliklerini inceleyin. Hassas ayrıntılar bu akışta gösterilmez.",
  "Recent activity": "Son etkinlikler",
  "Connect the tools your agent needs. Optional services can be unavailable without stopping local execution.": "Ajanınızın ihtiyaç duyduğu araçları bağlayın. İsteğe bağlı bir servis kullanılamasa da yerel çalıştırma devam eder.",
  "Save your changes, then restart Equinox Local to apply them.": "Değişikliklerinizi kaydedin, ardından uygulamak için Equinox Local’i yeniden başlatın.",
  "Stored privately on this computer. Your key is never shown again.": "Bu bilgisayarda özel olarak saklanır. Anahtarınız tekrar gösterilmez.",
  "Additional folders are read-only. This screen cannot grant write access.": "Ek klasörler salt okunurdur. Bu ekrandan yazma izni verilemez.",
  "If Agent Browser is unavailable, the task stops. Equinox Local never switches to your personal Chrome without an explicit choice.": "Agent Browser kullanılamıyorsa görev durur. Equinox Local, açık bir seçim olmadan kişisel Chrome’unuza geçmez.",
  "Agent paused": "Ajan duraklatıldı",
  "New actions are blocked. Read-only status is still available. Use Resume agent to continue.": "Yeni işlemler engellendi. Salt okunur durum bilgisi erişilebilir. Devam etmek için Ajanı sürdür düğmesini kullanın.",
  "Your agent is paused": "Ajanınız duraklatıldı",
  "Local stays connected for read-only status. Resume when you are ready; stopped work will not restart on its own.": "Yerel bağlantı, salt okunur durum bilgisi için açık kalır. Hazır olduğunuzda sürdürün; durdurulan işler kendiliğinden yeniden başlamaz.",
  "Your computer is ready": "Bilgisayarınız hazır",
  "Local tools are ready. Your agent stays in ChatGPT on the web; its connected tools run here on your computer.": "Yerel araçlar hazır. Ajanınız ChatGPT web’de kalır; bağlı araçları burada, bilgisayarınızda çalışır.",
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
  "Auto Continue maximum hops": "Auto Continue maksimum hop sayısı",
  "Default 10. Each hop must still be armed explicitly; this only changes the maximum chain length.": "Varsayılan 10. Her hop yine açıkça kurulmalıdır; bu ayar yalnızca zincirin maksimum uzunluğunu değiştirir.",
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
  "Inspect durable task checkpoints and take control when an automatic continuation should stop or change. Task state stays private on this computer.": "Kalıcı görev checkpoint’lerini inceleyin; otomatik devamın durması veya değişmesi gerektiğinde kontrolü alın. Görev durumu bu bilgisayarda özel kalır.",
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
  "Loopback only · Private to this computer": "Yalnızca loopback · Bu bilgisayara özel",
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
  "Installed and private to this computer.": "Kurulu ve yalnızca bu bilgisayara özel.",
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
  "Use a tunnel Runtime API key with Tunnels Read + Use. The key stays only on this computer.": "Tunnels Read + Use yetkilerine sahip bir tunnel Runtime API anahtarı kullanın. Anahtar yalnızca bu bilgisayarda kalır.",
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
  "Checking canonical main": "Canonical main kontrol ediliyor",
  "Reading local Git identity and checking the canonical public main branch without changing the checkout.": "Yerel Git kimliği okunuyor ve checkout değiştirilmeden canonical public main dalı kontrol ediliyor.",
  "Main update available": "Main güncellemesi var",
  "A newer canonical main SHA is available. M5 only reports it; no source files, Git refs, runtime state or user data are changed.": "Daha yeni bir canonical main SHA kullanılabilir. M5 bunu yalnızca bildirir; kaynak dosyalar, Git ref'leri, runtime durumu veya kullanıcı verileri değiştirilmez.",
  "Canonical main is up to date": "Canonical main güncel",
  "The current source SHA exactly matches the canonical public main branch.": "Mevcut kaynak SHA canonical public main dalıyla tam olarak eşleşiyor.",
  "Local main is ahead of canonical main": "Yerel main canonical main'in ilerisinde",
  "This checkout contains commits that are not on canonical main. Automatic main updates remain unavailable until the histories match.": "Bu checkout canonical main'de bulunmayan commit'ler içeriyor. Geçmişler eşleşene kadar otomatik main güncellemeleri kullanılamaz.",
  "Local ahead": "Yerel dal ileride",
  "Local and canonical main have diverged": "Yerel ve canonical main ayrışmış",
  "The histories have commits on both sides. Equinox Local will not treat this as an ordinary update path.": "Her iki geçmişte de yalnızca kendi tarafında bulunan commit'ler var. Equinox Local bunu sıradan bir güncelleme yolu olarak değerlendirmez.",
  "Diverged": "Ayrışmış",
  "Main update check is blocked": "Main güncelleme kontrolü engellendi",
  "This source checkout is not eligible for canonical main tracking.": "Bu kaynak checkout canonical main takibi için uygun değil.",
  "Unsupported": "Desteklenmiyor",
  "Main update check needs attention": "Main güncelleme kontrolü dikkat gerektiriyor",
  "The canonical main branch could not be checked. This is not an up-to-date result.": "Canonical main dalı kontrol edilemedi. Bu sonuç sistemin güncel olduğu anlamına gelmez.",
  "Check unavailable": "Kontrol kullanılamıyor",
  "Canonical main channel ready": "Canonical main kanalı hazır",
  "Check the canonical public main branch without modifying this source checkout.": "Bu kaynak checkout'u değiştirmeden canonical public main dalını kontrol edin.",
  "Check main": "Main'i kontrol et",
  "Current SHA —": "Mevcut SHA —",
  "Target SHA —": "Hedef SHA —",
  "Commit distance —": "Commit mesafesi —",
  "This source checkout is not eligible for canonical main discovery.": "Bu kaynak checkout canonical main keşfi için uygun değil.",
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
  "Allow shell commands, interactive shells and managed background processes with your normal logged-in user permissions. Terminal commands wait for a bounded foreground window; unfinished work continues as the same managed process instead of being restarted. Terminal is not confined to Selected roots after a shell starts; turn it off if you require strict selected-root containment. Equinox-managed provider credentials are not injected into generic shells or processes.": "Normal oturum açmış kullanıcı izinlerinizle kabuk komutlarına, etkileşimli kabuklara ve yönetilen arka plan süreçlerine izin verin. Terminal komutları sınırlı bir ön-plan bekleme penceresi kullanır; bitmeyen iş yeniden başlatılmadan aynı yönetilen süreç olarak devam eder. Bir kabuk başladıktan sonra Terminal Seçili köklerle sınırlı değildir; katı seçili-kök sınırı gerekiyorsa Terminal'i kapatın. Equinox tarafından yönetilen sağlayıcı kimlik bilgileri genel kabuklara veya süreçlere aktarılmaz.",
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
  "Terminal/process execution is the core terminal-first capability and uses your normal logged-in user permissions. Structured folder scope does not sandbox a running shell.": "Terminal/süreç çalıştırma temel terminal-first yeteneğidir ve normal oturum açmış kullanıcı izinlerinizi kullanır. Yapılandırılmış klasör kapsamı çalışan bir shell'i sandbox içine almaz.",
  "Allow the first-party desktop tool surface when macOS permissions are also granted.": "macOS izinleri de verildiğinde birinci taraf masaüstü araç yüzeyine izin verin.",
  "These controls exist for specialized containment and legacy configurations. They are not a sandbox for Terminal.": "Bu kontroller özel kısıtlama ihtiyaçları ve eski yapılandırmalar için korunur. Terminal için bir sandbox değildir.",
  "Applies only to root-aware structured capabilities such as project discovery and image viewing. Terminal uses the logged-in user's permissions.": "Yalnızca proje keşfi ve görsel görüntüleme gibi kök-farkındalıklı yapılandırılmış yeteneklere uygulanır. Terminal oturum açmış kullanıcının izinlerini kullanır.",
  "Turning this off disables Terminal, interactive shells and managed processes. Equinox Local becomes heavily restricted and many agent tasks will no longer work.": "Bunu kapatmak Terminal'i, etkileşimli shell'leri ve yönetilen süreçleri devre dışı bırakır. Equinox Local ciddi biçimde kısıtlanır ve birçok ajan görevi artık çalışmaz.",
  "Browser/Desktop and advanced access changes use the validated configuration path and require a Local restart. Emergency Stop/Resume apply immediately and do not edit configuration.": "Tarayıcı/Masaüstü ve gelişmiş erişim değişiklikleri doğrulanmış yapılandırma yolunu kullanır ve Local'in yeniden başlatılmasını gerektirir. Acil Durdur/Sürdür anında uygulanır ve yapılandırmayı değiştirmez.",
  "Agent resumed.": "Ajan sürdürüldü.",
  "Emergency Stop activated. Agent mutations are paused.": "Acil Durdur etkinleştirildi. Ajanın değişiklik yapan işlemleri duraklatıldı.",
  "Structured shortcut": "Yapılandırılmış kısayol",
  "Structured scope": "Yapılandırılmış kapsam",
  "Managed installation": "Yönetilen kurulum",
  "Uninstall Equinox Local": "Equinox Local'i kaldır",
  "Managed only": "Yalnızca yönetilen kurulum",
  "Remove the managed runtime, startup registration, tunnel credentials and Equinox Browser Native Messaging host from this computer. By default, your Equinox Workspace and Control Center configuration are preserved.": "Yönetilen runtime'ı, başlangıç kaydını, tunnel kimlik bilgilerini ve Equinox Browser Native Messaging host'unu bu bilgisayardan kaldırın. Varsayılan olarak Equinox Çalışma Alanınız ve Kontrol Merkezi yapılandırmanız korunur.",
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
  "Files sent from ChatGPT to this computer are saved here by default. Explicit destinations still override this folder.": "ChatGPT’den bu bilgisayara gönderilen dosyalar varsayılan olarak buraya kaydedilir. Açıkça belirtilen hedef klasörler bu ayarı geçersiz kılar.",
  "Web file transfer folder updated.": "Web dosya aktarım klasörü güncellendi.",
  "Web file transfer folder reset to default.": "Web dosya aktarım klasörü varsayılana döndürüldü.",
  "Download folder": "İndirme klasörü",
  "Change folder…": "Klasörü değiştir…",
  "Reset to default": "Varsayılana dön",
  "Incoming Telegram photos and documents are saved here. Changing this affects only new files; existing task attachments stay where they are. Files in this user-visible folder are not auto-deleted.": "Telegram’dan gelen fotoğraf ve belgeler buraya kaydedilir. Bu ayarı değiştirmek yalnızca yeni dosyaları etkiler; mevcut görev ekleri bulundukları yerde kalır. Kullanıcıya görünür bu klasördeki dosyalar otomatik silinmez.",
  "Telegram download folder updated.": "Telegram indirme klasörü güncellendi.",
  "Telegram download folder reset to default.": "Telegram indirme klasörü varsayılana döndürüldü.",
  "Choosing…": "Seçiliyor…",
  "Use the native folder picker or enter an absolute path manually. Equinox Local validates the selection and never grants the filesystem root.": "Yerel klasör seçicisini kullanın veya mutlak yolu elle girin. Equinox Local seçimi doğrular ve dosya sisteminin kökünü hiçbir zaman açmaz.",
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
  "The token stays only on this computer. Telegram user ID is discovered during pairing.": "Token yalnızca bu bilgisayarda kalır. Telegram kullanıcı ID’si eşleştirme sırasında otomatik bulunur.",
  "Recommended. Telegram lets Equinox Local reach you away from this computer and will become the remote task inbox for agent replies and controls.": "Önerilen. Telegram, bu bilgisayarın başında değilken Equinox Local’in size ulaşmasını sağlar ve ajan yanıtları ile kontrolleri için uzaktan görev gelen kutusu olacaktır.",
  "Open BotFather in Telegram and send /newbot.": "Telegram’da BotFather’ı açın ve /newbot gönderin.",
  "Choose a display name and a unique bot username when BotFather asks.": "BotFather istediğinde görünen bir ad ve benzersiz bir bot kullanıcı adı seçin.",
  "Copy the HTTP API token BotFather gives you and paste it below.": "BotFather’ın verdiği HTTP API tokenını kopyalayıp aşağıya yapıştırın.",
  "Choose Pair Telegram, open your new bot, and send /start.": "Telegram’ı eşleştir’i seçin, yeni botunuzu açın ve /start gönderin.",
  "Equinox Local will show the detected private account here. Confirm it before anything is saved.": "Equinox Local algılanan özel hesabı burada gösterecek. Herhangi bir şey kaydedilmeden önce hesabı doğrulayın.",
  "The token stays only on this computer. Do not share it with the agent or paste it into chat.": "Token yalnızca bu bilgisayarda kalır. Ajanla paylaşmayın veya sohbete yapıştırmayın.",
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
  "Folder path must be an absolute non-root local path.": "Klasör yolu mutlak, yerel ve dosya sistemi kökünden farklı olmalıdır.",
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
  "Keep API credentials on this computer while allowing agents to make bounded requests only to the HTTPS origins, methods and paths you approve.": "API kimlik bilgilerini bu bilgisayarda tutarken ajanların yalnızca onayladığınız HTTPS origin, yöntem ve yollara sınırlı istekler göndermesine izin verin.",
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
  "Private on this computer · 127.0.0.1": "Bu bilgisayara özel · 127.0.0.1",
  "Checking your computer": "Bilgisayarınız kontrol ediliyor",
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

export function translateUiText(value, language = "en") {
  const source = String(value ?? "");
  if (normalizeLanguage(language) !== "tr" || !source) return source;
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
  match = source.match(/^Current SHA ([a-f0-9]{7})$/u);
  if (match) return `Mevcut SHA ${match[1]}`;
  match = source.match(/^Target SHA ([a-f0-9]{7})$/u);
  if (match) return `Hedef SHA ${match[1]}`;
  match = source.match(/^Distance ↓(\d+) ↑(\d+)$/u);
  if (match) return `Mesafe ↓${match[1]} ↑${match[2]}`;
  match = source.match(/^(\d+) commits? available on main$/u);
  if (match) return `main'de ${match[1]} commit kullanılabilir`;
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

export function translateDoctorDetail(item, language = "en") {
  const detail = String(item?.detail || "No additional detail.");
  return translateUiText(detail, language);
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

export function translateRuntimeEventMessage(message, language = "en") {
  const english = legacyEventMessageToEnglish(message);
  if (normalizeLanguage(language) !== "tr") return english;
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

  return translateUiText(english, language);
}
