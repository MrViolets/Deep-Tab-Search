'use strict'

const gulp = require('gulp')
const path = require('path')
const pkg = require('./package.json')
const colors = require('colors/safe')
const zip = require('gulp-zip')
const imagemin = require('gulp-imagemin')
const jsonEditor = require('gulp-json-editor')
const { exec } = require('child_process')

colors.setTheme({
  error: 'red'
})

function logMessage (message) {
  console.log(`${message}`)
}

gulp.task('update-version', function (cb) {
  const manifestPath = path.join(__dirname, 'src', 'manifest.json')
  const manifest = require(manifestPath)
  const version = manifest.version

  return gulp.src('./package.json')
    .pipe(jsonEditor({ version }))
    .pipe(gulp.dest('./'))
    .on('end', function () {
      exec('npm install', { cwd: './' }, function (error) {
        if (error) {
          logMessage(colors.error('Error running npm install: ' + error))
          return
        }
        cb()
      })
    })
    .on('error', function (err) {
      logMessage(colors.error('Error updating version in package.json: ' + err.toString()))
    })
})

gulp.task('build-chrome', function () {
  const manifestPath = path.join(__dirname, 'src', 'manifest.json')
  const manifest = require(manifestPath)
  const version = manifest.version

  return gulp.src(['src/**'])
    .pipe(imagemin([imagemin.optipng({ optimizationLevel: 5 })]))
    .pipe(zip(`${pkg.name}-v${version}.zip`))
    .pipe(gulp.dest('build'))
})

gulp.task('build', gulp.series('update-version', 'build-chrome'))
