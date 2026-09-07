pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "phone-control-android"

// Le moteur de regles est un module Kotlin PUR, sans Android : la specification
// exige qu'il soit testable sans dependre de l'interface (section 55). Il tourne
// donc sur la JVM, en quelques secondes, sans emulateur ni telephone.
include(":core-rules")
include(":app")
