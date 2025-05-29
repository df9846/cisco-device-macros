import xapi from 'xapi';

// Mapping color names to URLs
const wallpaperURLs = {
  Red:    'Your_URL_red_base64.txt',
  Green:  'Your_URL_green_base64.txt',
  Yellow: 'Your_URL_yellow_base64.txt'
};

const customIdMap = {
  Red: '10',
  Green: '20',
  Yellow: '30'
};

async function fetchAndUpload(color) {
  const url = wallpaperURLs[color];
  if (!url) {
    console.log(`No URL configured for color: ${color}`);
    return;
  }

  try {
    // Do the HTTP GET call using xapi
    const response = await xapi.Command.HttpClient.Get({ Url: url });
    const base64 = response.Body;

    await xapi.Command.UserInterface.Branding.Upload(
      {
        CustomId: customIdMap[color],
        Type: 'SchedulerBackground'
      },
      base64
    );
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