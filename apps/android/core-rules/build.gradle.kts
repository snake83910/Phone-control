import org.gradle.api.tasks.PathSensitivity

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

/*
 * Moteur de regles metier — module Kotlin PUR.
 *
 * Aucune dependance Android : la specification (section 55) exige que cette
 * logique soit testable sans l'interface. Consequence pratique : la suite
 * s'execute sur la JVM en quelques secondes, sans emulateur ni telephone, et
 * peut donc tourner en integration continue.
 */
dependencies {
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.serialization.json)
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnit()
    // Les scenarios de reference sont partages avec la suite Jest du serveur :
    // ils vivent hors du projet Android, dans packages/state-machine-spec.
    val scenarios = rootProject.projectDir.parentFile.parentFile
        .resolve("packages/state-machine-spec/scenarios")
    systemProperty("scenarios.dir", scenarios.absolutePath)
    // Les scenarios vivent hors du projet Gradle : sans cette declaration
    // d'entree, modifier un fichier JSON laisserait la tache "UP-TO-DATE" et
    // le test ne serait pas rejoue. Un garde-fou qui ne s'execute pas ne garde
    // rien du tout.
    inputs.dir(scenarios).withPathSensitivity(PathSensitivity.RELATIVE)
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}
