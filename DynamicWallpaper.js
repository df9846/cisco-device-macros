import xapi from 'xapi';

// Mapping color names to URLs
const wallpaperURLs = {
  Red:    'Your_image_URL_red',
  Green:  'Your_image_URL_green',
  Yellow: 'Your_image_URL_yellow'
};

const customIdMap = {
  Red: 'wallpaper_red',
  Green: 'wallpaper_green',
  Yellow: 'wallpaper_yellow'
};

async function fetchAndUpload(color) {
  const url = wallpaperURLs[color];
  if (!url) {
    console.log(`No URL configured for color: ${color}`);
    return;
  }

  try {
    await xapi.Command.UserInterface.Branding.Fetch({ CustomId: customIdMap[color], Type: 'SchedulerBackground', url});       
    console.log(`Successfully uploaded wallpaper for ${color}`);
  } catch (err) {
    console.log(`Failed to fetch/upload wallpaper for ${color}: ${err}`);
  }
}

// Watch for color changes
xapi.status.on('UserInterface LedControl Color', value => {
  console.log('Detected Color Change:', value);
  fetchAndUpload(value);
});

// On startup, set initial wallpaper
xapi.status.get('UserInterface LedControl Color').then(color => {
  console.log('Initial Color Value:', color);
  fetchAndUpload(color);
});

