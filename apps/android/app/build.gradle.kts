import org.gradle.api.tasks.PathSensitivity

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
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

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:3001/api/\"")
        }
        release {
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
