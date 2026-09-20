import org.gradle.api.tasks.PathSensitivity
// Importé plutôt que qualifié : dans un script Kotlin de Gradle, `java`
// désigne l'extension du greffon Java, pas le paquet — `java.util.Properties`
// ne résout donc pas.
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

/**
 * Clé de signature de release.
 *
 * ── Ce qu'elle est ──────────────────────────────────────────────────────
 * Irremplaçable, au même titre que `BADGE_HMAC_PEPPER` et `DEVICE_MASTER_KEY`.
 * Android refuse d'installer une mise à jour signée par une clé différente de
 * celle de l'installation en place : pas de contournement, pas de procédure de
 * secours. La perdre après avoir déployé une flotte, c'est réinitialiser
 * chaque téléphone en usine et le ré-enrôler à la main.
 *
 * ── Pourquoi rien n'est écrit ici ───────────────────────────────────────
 * Ni chemin, ni mot de passe, ni alias. Ce fichier est versionné ; le
 * keystore et ses mots de passe ne doivent exister que sur la machine qui
 * construit. Deux sources acceptées, l'environnement l'emportant sur le
 * fichier pour qu'une intégration continue n'hérite pas d'un reliquat local :
 *
 *   - variables : PC_KEYSTORE_FILE, PC_KEYSTORE_PASSWORD, PC_KEY_ALIAS,
 *     PC_KEY_PASSWORD ;
 *   - fichier `apps/android/keystore.properties` (ignoré par git) portant
 *     storeFile, storePassword, keyAlias, keyPassword.
 *
 * Absente, la construction de release ÉCHOUE — voir la tâche plus bas. Elle
 * produisait jusqu'ici un APK non signé, qu'Android accepte de fabriquer et
 * refuse d'installer : la panne n'apparaissait qu'au téléphone, à l'atelier.
 */
val proprietesSignature: Map<String, String>? = run {
    val fichier = rootProject.file("keystore.properties")
    val depuisFichier: Map<String, String> = if (fichier.exists()) {
        val proprietes = Properties()
        fichier.inputStream().use { flux -> proprietes.load(flux) }
        proprietes.stringPropertyNames().associateWith { nom -> proprietes.getProperty(nom) }
    } else {
        emptyMap()
    }

    val valeur = { cle: String, variable: String ->
        (System.getenv(variable) ?: depuisFichier[cle])?.takeIf { it.isNotBlank() }
    }

    val store = valeur("storeFile", "PC_KEYSTORE_FILE")
    val storePwd = valeur("storePassword", "PC_KEYSTORE_PASSWORD")
    val alias = valeur("keyAlias", "PC_KEY_ALIAS")
    val keyPwd = valeur("keyPassword", "PC_KEY_PASSWORD")

    if (store == null || storePwd == null || alias == null || keyPwd == null) {
        null
    } else {
        mapOf(
            "storeFile" to store,
            "storePassword" to storePwd,
            "keyAlias" to alias,
            "keyPassword" to keyPwd,
        )
    }
}

android {
    namespace = "com.phonecontrol"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.phonecontrol"
        // API 28 : setLockTaskFeatures, DISALLOW_AIRPLANE_MODE et
        // DISALLOW_CONFIG_LOCATION n'existent qu'a partir d'Android 9. Descendre
        // plus bas donnerait un kiosque incomplet sur les anciens terminaux,
        // sans que rien ne le signale.
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://api.phone-control.local/api/\"")

        // Empreinte SHA-256 attendue du certificat de signature, en hexadecimal.
        // Vide par defaut : l'application signale alors « non verifiable »
        // plutot que « signature invalide » — la nuance evite une alerte
        // critique sur un simple defaut de configuration.
        //
        // A renseigner au moment de la publication :
        //   ./gradlew :app:assembleRelease -PexpectedSignatureSha256=<empreinte>
        // Le maillon faible est connu : qui reconstruit l'APK peut aussi changer
        // cette valeur. Le controle n'attrape que le repackaging naif ; la forme
        // robuste (empreinte fournie par le serveur a l'enrolement) est notee en
        // Phase 7.
        buildConfigField(
            "String",
            "EXPECTED_SIGNATURE_SHA256",
            "\"${project.findProperty("expectedSignatureSha256") ?: ""}\"",
        )

        // Epinglage de certificat (docs/07 §5). Vide par defaut : sans ces
        // valeurs, la connexion reste protegee par TLS ordinaire.
        //
        // DEUX empreintes distinctes sont exigees — celle en service et celle qui
        // prendra sa suite — ainsi qu'une date d'expiration apres laquelle
        // l'epinglage se leve tout seul. Sans ces garde-fous, le renouvellement
        // du certificat immobiliserait toute la flotte le meme jour, sans moyen
        // de la corriger a distance.
        //
        //   ./gradlew :app:assembleRelease         //     -PpinnedHost=api.exemple.fr         //     -PpinnedPublicKeys=<empreinte1>,<empreinte2>         //     -PpinningExpiresAt=2027-09-05T00:00:00Z
        buildConfigField("String", "PINNED_HOST", "\"${project.findProperty("pinnedHost") ?: ""}\"")
        buildConfigField(
            "String",
            "PINNED_PUBLIC_KEYS",
            "\"${project.findProperty("pinnedPublicKeys") ?: ""}\"",
        )
        buildConfigField(
            "String",
            "PINNING_EXPIRES_AT",
            "\"${project.findProperty("pinningExpiresAt") ?: ""}\"",
        )
    }

    signingConfigs {
        if (proprietesSignature != null) {
            create("release") {
                storeFile = file(proprietesSignature.getValue("storeFile"))
                storePassword = proprietesSignature.getValue("storePassword")
                keyAlias = proprietesSignature.getValue("keyAlias")
                keyPassword = proprietesSignature.getValue("keyPassword")

                // v1 (JAR) explicitement DÉSACTIVÉ. L'outil de provisioning
                // refuse un APK signé en v1 seul, et `minSdk` vaut 28 : v2
                // existe depuis Android 7, donc aucun terminal visé n'en a
                // besoin. Le laisser actif ferait passer pour v1 un APK qu'on
                // croit en v2, ce qui ne se verrait qu'au calcul de
                // l'empreinte — cf. docs/12.
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:3001/api/\"")
        }
        release {
            // `findByName` et non `getByName` : sans clé, la configuration
            // n'existe pas et Gradle échouerait dès la lecture du projet — y
            // compris pour lancer les tests unitaires, qui n'ont rien à voir
            // avec la signature. Le refus est porté par la tâche de
            // construction, plus bas.
            signingConfig = signingConfigs.findByName("release")

            isMinifyEnabled = true
            isShrinkResources = true

            // SQLCipher embarque une bibliotheque native par architecture.
            // Les quatre variantes pesaient 20 Mo a elles seules, dont la
            // moitie pour x86 et x86_64 — c'est-a-dire pour des emulateurs, que
            // l'on ne provisionne pas. L'APK de debug, lui, les conserve : c'est
            // sur emulateur que tournent les tests instrumentes.
            //
            // Consequence assumee : l'APK de release ne s'installe pas sur un
            // emulateur x86. C'est le bon arbitrage — il est telecharge par des
            // telephones, au provisioning, sur le Wi-Fi de l'atelier.
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    sourceSets {
        // Schemas Room exportes, exposes en assets de la variante debug.
        //
        // MigrationTestHelper les lit depuis les assets, et les tests unitaires
        // Robolectric consomment ceux de la variante testee -- il n'existe pas
        // de fusion d'assets propre aux tests unitaires. Les mettre en `debug`
        // les rend donc visibles aux tests sans les embarquer dans l'APK de
        // production, ou ils ne serviraient a rien.
        getByName("debug") { assets.srcDir("$projectDir/schemas") }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            // Le manifeste est lu par ManifestQueriesTest : sans cette
            // declaration, Gradle considere le test a jour apres une
            // modification du manifeste et ne le rejoue pas.
            it.inputs.file(projectDir.resolve("src/main/AndroidManifest.xml"))
                .withPathSensitivity(PathSensitivity.RELATIVE)
            // Contrat des extras de provisioning : le meme fichier contraint
            // l'outil d'atelier qui FABRIQUE le QR code et le recepteur qui le
            // CONSOMME. Renommer une cle d'un seul cote ferait echouer tous les
            // enrolements du parc, sans message d'erreur utile.
            val contract = rootProject.projectDir.parentFile.parentFile
                .resolve("packages/provisioning-payload/src/contract/admin-extras.json")
            it.systemProperty("provisioning.contract", contract.absolutePath)
            // Sans cette declaration, Gradle ignore que le contrat est une
            // entree de la tache : modifier le fichier laisserait le test
            // "UP-TO-DATE", et la divergence passerait inapercue. Le garde-fou
            // aurait alors l'exact defaut qu'il est cense empecher.
            it.inputs.file(contract).withPathSensitivity(PathSensitivity.RELATIVE)
            it.testLogging {
                events("passed", "failed", "skipped")
            }
        }
    }
}

// Le schema Room est exporte et versionne : c'est ce qui permettra d'ecrire des
// migrations sures quand la base evoluera, plutot que de decouvrir la structure
// precedente par archeologie.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.incremental", "true")
}

dependencies {
    implementation(project(":core-rules"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.navigation.compose)
    implementation(libs.androidx.hilt.work)
    ksp(libs.androidx.hilt.compiler)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)
    // Base locale chiffree (docs/07 §5) : SQLCipher remplace le moteur SQLite
    // d'Android, Room le pilote a travers l'interface androidx.sqlite.
    implementation(libs.sqlcipher.android)
    implementation(libs.androidx.sqlite)

    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    // Variante « bundled » : le scanner doit fonctionner sur un terminal
    // d'entreprise depourvu de Google Play Services (docs/01 §2.5).
    implementation(libs.mlkit.barcode)
    implementation(libs.play.services.location)

    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.room.testing)
    testImplementation(libs.androidx.test.junit)

    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.espresso)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
}

/**
 * Refuse de construire une release non signée.
 *
 * ── Pourquoi une tâche et pas une vérification à la configuration ───────
 * Gradle évalue la configuration pour TOUTE commande, y compris `test`. Un
 * `error()` posé plus haut empêcherait de lancer les tests unitaires sur une
 * machine qui n'a pas le keystore — c'est-à-dire sur toutes les machines sauf
 * une. Le refus n'a de sens qu'au moment où l'on fabrique réellement l'objet
 * qui sera installé.
 *
 * ── Pourquoi refuser plutôt que produire ────────────────────────────────
 * Sans signature, Gradle fabrique quand même un APK. Il se copie, il
 * s'héberge, il se télécharge — et c'est le téléphone qui le refuse, à
 * l'atelier, devant l'opérateur. L'erreur doit tomber ici.
 */
// Un booléen, et non `proprietesSignature`, parce que la fermeture est
// SÉRIALISÉE par le cache de configuration : y capturer une valeur du script
// fait échouer la construction sur « cannot serialize Gradle script object
// references ». Un `Boolean` se sérialise, une référence au script non.
val signatureAbsente = proprietesSignature == null

tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }
    .configureEach {
        // Recopié dans une variable LOCALE avant `doFirst`. Lire directement
        // `signatureAbsente` ferait de la fermeture une référence au script —
        // c'est un champ de la classe du script, donc `this` part avec —, et
        // c'est exactement ce que le cache de configuration refuse de
        // sérialiser. La locale, elle, est un simple booléen.
        val absente = signatureAbsente
        doFirst {
            if (absente) {
                error(
                    "Aucune clé de signature de release.\n\n" +
                        "Renseignez soit les variables PC_KEYSTORE_FILE, " +
                        "PC_KEYSTORE_PASSWORD, PC_KEY_ALIAS et PC_KEY_PASSWORD, " +
                        "soit apps/android/keystore.properties (ignoré par git).\n\n" +
                        "Cette clé est IRREMPLAÇABLE : Android refuse toute mise à " +
                        "jour signée par une autre. Sauvegardez-la hors de cette " +
                        "machine avant d'enrôler le premier téléphone. " +
                        "Voir docs/20-deploiement-vps.md.",
                )
            }
        }
    }
