import xapi from 'xapi';

function createPanel() {
  const panel =  `
<Extensions>
<Version>1.11</Version>
<Panel>
<Order>15</Order>
<PanelId>stdiag</PanelId>
<Origin>local</Origin>
<Location>ControlPanel</Location>
<Icon>Camera</Icon>
<Color>#6F739E</Color>
<Name>Camera Diagnostics</Name>
<ActivityType>Custom</ActivityType>
<Page>
<Name>SpeakerTrack</Name>
<Row>
<Name>Enable Diagnostics</Name>
<Widget>
<WidgetId>widget_stdiag</WidgetId>
<Type>ToggleButton</Type>
<Options>size=1</Options>
</Widget>
</Row>
<Options/>
</Page>
</Panel>
</Extensions>`

  xapi.Command.UserInterface.Extensions.Panel.Save(
        { PanelId: 'stdiag' },
        panel
      );
}


createPanel();

function diagnosticsonoff (event){
  if (event.WidgetId === 'widget_stdiag' && event.Value === 'on'){
      xapi.Command.UserInterface.Extensions.Panel.Close(); 
   xapi.Command.Cameras.SpeakerTrack.Diagnostics.Start();
   xapi.Command.Video.Selfview.Set(
    { FullscreenMode: 'On', Mode: 'On', OnMonitorRole: 'First'});
      }
      
  else if (event.WidgetId === 'widget_stdiag' && event.Value === 'off'){
    xapi.Command.UserInterface.Extensions.Panel.Close();
   xapi.Command.Cameras.SpeakerTrack.Diagnostics.Stop();
   xapi.Command.Video.Selfview.Set(
    { FullscreenMode: 'Off', Mode: 'Off', OnMonitorRole: 'First'});
      };
}

xapi.Event.UserInterface.Extensions.Widget.Action.on(diagnosticsonoff);

